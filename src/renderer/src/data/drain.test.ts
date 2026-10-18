import { describe, expect, it, vi } from 'vitest'
import type { BankrollMove, Bet, MoveInput, Settings } from '../../../shared/types'
import { DEFAULT_SETTINGS } from '../../../shared/types'
import { bet } from '../test-utils'
import { afterFailedRead, combinedStatus, drainOutbox, foldApplied, migrationNotice, pushSettings, retryPlan, syncStatus, type DrainHooks } from './drain'
import { describeError, MigrationNeededError, SignedOutError } from './errors'
import { afterSettingsAnswer, applyMoveOutbox, applyOutbox, enqueueOp, insertStamp, reconcileMove, requeueRefused, type MoveOp, type PendingOp, type PendingSettings } from './offline'

const add = (id: string): PendingOp => ({ opId: `op-${id}`, kind: 'add', id, input: { date: '2026-03-01', amount: 5 }, queuedAt: 'Q' })
const del = (id: string): PendingOp => ({ opId: `op-del-${id}`, kind: 'delete', id })

const offline = () => new TypeError('Failed to fetch')
const refused = () => new Error('permission denied for table entries')

/** An in-memory queue plus a record of what the drain did with it. */
function harness(initial: PendingOp[], send: (op: PendingOp) => Promise<Bet | null>) {
  let queue = [...initial]
  const sent: string[] = []
  const applied: string[] = []
  const rejected: string[] = []
  const hooks: DrainHooks = {
    outbox: () => queue,
    update: (fn) => (queue = fn(queue)),
    send: (op) => {
      sent.push(op.opId)
      return send(op)
    },
    applied: (op) => void applied.push(op.opId),
    rejected: (ops) => void rejected.push(...ops.map((o) => o.opId))
  }
  return { hooks, sent, applied, rejected, queue: () => queue.map((o) => o.opId) }
}

describe('drainOutbox', () => {
  it('sends every op in order and empties the queue', async () => {
    const h = harness([add('a'), add('b'), del('c')], async (op) => (op.kind === 'add' ? bet({ id: op.id }) : null))
    expect(await drainOutbox(h.hooks)).toEqual({ stop: 'done', processed: 3 })
    expect(h.sent).toEqual(['op-a', 'op-b', 'op-del-c'])
    expect(h.applied).toEqual(['op-a', 'op-b', 'op-del-c'])
    expect(h.queue()).toEqual([])
  })

  it('keeps the op and everything after it when the server is unreachable', async () => {
    const h = harness([add('a'), add('b'), add('c')], async (op) => {
      if (op.opId === 'op-b') throw offline()
      return bet()
    })
    expect(await drainOutbox(h.hooks)).toEqual({ stop: 'offline', processed: 1 })
    expect(h.queue()).toEqual(['op-b', 'op-c'])
    expect(h.rejected).toEqual([])
  })

  it('keeps the op and everything after it when the database is missing a migration', async () => {
    const h = harness([add('a'), add('b'), del('c')], async () => {
      throw new MigrationNeededError()
    })
    const out = await drainOutbox(h.hooks)
    expect(out.stop).toBe('behind')
    expect(out.processed).toBe(0)
    expect(out.stop === 'behind' && out.error).toBeInstanceOf(MigrationNeededError)
    // Nothing is dropped and nothing after the first op is even tried.
    expect(h.queue()).toEqual(['op-a', 'op-b', 'op-del-c'])
    expect(h.sent).toEqual(['op-a'])
    expect(h.rejected).toEqual([])
  })

  it('sends the kept ops once the migration has run', async () => {
    let migrated = false
    const h = harness([add('a'), add('b')], async () => {
      if (!migrated) throw new MigrationNeededError()
      return bet()
    })
    expect((await drainOutbox(h.hooks)).stop).toBe('behind')
    migrated = true
    expect(await drainOutbox(h.hooks)).toEqual({ stop: 'done', processed: 2 })
    expect(h.applied).toEqual(['op-a', 'op-b'])
    expect(h.queue()).toEqual([])
  })

  it('sends an op queued while a request is out, after it', async () => {
    let h: ReturnType<typeof harness>
    h = harness([add('a')], async (op) => {
      if (op.opId === 'op-a') h.hooks.update((q) => [...q, add('d')])
      return bet()
    })
    expect(await drainOutbox(h.hooks)).toEqual({ stop: 'done', processed: 2 })
    expect(h.sent).toEqual(['op-a', 'op-d'])
    expect(h.queue()).toEqual([])
  })

  it('keeps an op queued while a request is out when that request finds the database behind', async () => {
    let h: ReturnType<typeof harness>
    h = harness([add('a')], async () => {
      h.hooks.update((q) => [...q, add('d')])
      throw new MigrationNeededError()
    })
    expect((await drainOutbox(h.hooks)).stop).toBe('behind')
    expect(h.queue()).toEqual(['op-a', 'op-d'])
  })

  it('keeps the op and everything after it when the session ends partway (signed out on another device)', async () => {
    const h = harness([add('a'), add('b'), del('c')], async (op) => {
      if (op.opId !== 'op-a') throw new SignedOutError()
      return bet()
    })
    const out = await drainOutbox(h.hooks)
    expect(out).toMatchObject({ stop: 'paused', processed: 1 })
    expect(h.queue()).toEqual(['op-b', 'op-del-c'])
    expect(h.rejected).toEqual([])
  })

  // Used to be dropped as a refusal: a 503 or a rate limit lost the change.
  it('keeps the op and everything after it when the server fails for now (5xx, 429), to try again later', async () => {
    for (const status of [500, 502, 503, 504, 429]) {
      const h = harness([add('a'), add('b')], async (op) => {
        if (op.opId === 'op-b') throw describeError({ message: 'try later' }, status)
        return bet()
      })
      const out = await drainOutbox(h.hooks)
      expect(out, String(status)).toMatchObject({ stop: 'retry', processed: 1 })
      expect(h.queue(), String(status)).toEqual(['op-b'])
      expect(h.rejected, String(status)).toEqual([])
    }
  })

  it('sends an op as it is stored when it goes: an edit folded into it by another window just before goes too', async () => {
    let queue: PendingOp[] = [add('a')]
    const sentInputs: unknown[] = []
    let first = true
    const hooks: DrainHooks = {
      outbox: () => queue,
      update: (fn) => {
        // Another window folds an edit into the add while this one waits for the lock.
        if (first) queue = queue.map((o) => (o.kind === 'add' ? { ...o, input: { date: '2026-03-01', amount: 9 } } : o))
        first = false
        return (queue = fn(queue))
      },
      send: async (op) => {
        sentInputs.push(op.kind === 'add' ? op.input.amount : null)
        return bet()
      },
      applied: () => {},
      rejected: () => {}
    }
    expect(await drainOutbox(hooks)).toEqual({ stop: 'done', processed: 1 })
    expect(sentInputs).toEqual([9])
  })

  it('skips an op another window cancelled before it went', async () => {
    let queue: PendingOp[] = [add('a'), add('b')]
    const sent: string[] = []
    let first = true
    const hooks: DrainHooks = {
      outbox: () => queue,
      update: (fn) => {
        // Deleted in another window (an add that never went is cancelled outright).
        if (first) queue = queue.filter((o) => o.opId !== 'op-a')
        first = false
        return (queue = fn(queue))
      },
      send: async (op) => {
        sent.push(op.opId)
        return bet()
      },
      applied: () => {},
      rejected: () => {}
    }
    expect(await drainOutbox(hooks)).toEqual({ stop: 'done', processed: 1 })
    expect(sent).toEqual(['op-b'])
  })

  it('keeps what an interrupted import confirmed, so the next try starts after it', async () => {
    const entries = Array.from({ length: 600 }, (_, i) => ({ id: `r${i}`, input: { date: '2026-03-01', amount: 1 } }))
    const h = harness([{ opId: 'op-import', kind: 'bulk-add', entries, queuedAt: 'Q' }], async (_op) => {
      throw new TypeError('Failed to fetch')
    })
    h.hooks.send = async (_op, progress) => {
      await progress(250)
      throw new TypeError('Failed to fetch')
    }
    expect(await drainOutbox(h.hooks)).toEqual({ stop: 'offline', processed: 0 })
    const op = (h.hooks.outbox() as PendingOp[])[0]
    expect(op.kind === 'bulk-add' && op.done).toBe(250)
    expect(op.sent).toBe(true)
  })

  it('drops an op the server refuses for good, and carries on', async () => {
    const h = harness([add('a'), add('b'), add('c')], async (op) => {
      if (op.opId === 'op-b') throw refused()
      return bet()
    })
    expect(await drainOutbox(h.hooks)).toEqual({ stop: 'done', processed: 2 })
    expect(h.rejected).toEqual(['op-b'])
    expect(h.applied).toEqual(['op-a', 'op-c'])
    expect(h.queue()).toEqual([])
  })
})

describe('pushSettings', () => {
  const ROW: Settings = { ...DEFAULT_SETTINGS, defaultStake: 25, updatedAt: 'E' }

  function settingsHarness(initial: PendingSettings | null, save: (p: PendingSettings) => Promise<Settings | null>) {
    let pending = initial
    return {
      hooks: {
        pending: () => pending,
        settle: (sent: PendingSettings) => {
          pending = afterSettingsAnswer(pending, sent)
        },
        save
      },
      pending: () => pending,
      set: (next: PendingSettings | null) => {
        pending = next
      }
    }
  }

  const patch: PendingSettings = { patch: { defaultStake: 25 }, editedAt: 'E' }

  it('does nothing when no patch is queued', async () => {
    const h = settingsHarness(null, async () => ROW)
    expect(await pushSettings(h.hooks)).toBeNull()
  })

  it('clears the patch once it is saved', async () => {
    const h = settingsHarness(patch, async () => ROW)
    expect(await pushSettings(h.hooks)).toEqual({ stop: 'saved', row: ROW })
    expect(h.pending()).toBeNull()
  })

  it('clears it too when a newer edit from another device already landed', async () => {
    const h = settingsHarness(patch, async () => null)
    expect(await pushSettings(h.hooks)).toEqual({ stop: 'conflict' })
    expect(h.pending()).toBeNull()
  })

  it('keeps a patch merged while the request was out', async () => {
    const merged: PendingSettings = { patch: { defaultStake: 25, lossLimit: 500 }, editedAt: 'F' }
    const h = settingsHarness(patch, async () => {
      h.set(merged)
      return ROW
    })
    await pushSettings(h.hooks)
    // What went is saved; the edit made meanwhile is still to go.
    expect(h.pending()).toEqual({ patch: { lossLimit: 500 }, editedAt: 'F' })
  })

  // Used to clear the queue whatever was in it: the edit made while the
  // refused one was out was lost.
  it('a refusal settles only the patch that went: an edit made while it was out stays', async () => {
    const h = settingsHarness(patch, async () => {
      h.set({ patch: { defaultStake: 25, oddsFormat: 'decimal' }, editedAt: 'F' })
      throw refused()
    })
    expect((await pushSettings(h.hooks))?.stop).toBe('rejected')
    expect(h.pending()).toEqual({ patch: { oddsFormat: 'decimal' }, editedAt: 'F' })
  })

  it('a field changed again while the patch was out stays at its new value, whatever the answer', async () => {
    for (const answer of ['saved', 'conflict', 'refused'] as const) {
      const h = settingsHarness(patch, async () => {
        h.set({ patch: { defaultStake: 30 }, editedAt: 'F' })
        if (answer === 'refused') throw refused()
        return answer === 'saved' ? ROW : null
      })
      await pushSettings(h.hooks)
      expect(h.pending(), answer).toEqual({ patch: { defaultStake: 30 }, editedAt: 'F' })
    }
  })

  // A newer edit from another device beat the one that went: sending that
  // field again with the later edit's time would undo theirs.
  it('a conflict drops the fields that lost, and keeps the ones edited since', async () => {
    const h = settingsHarness(patch, async () => {
      h.set({ patch: { defaultStake: 25, lossLimit: 500 }, editedAt: 'F' })
      return null
    })
    expect(await pushSettings(h.hooks)).toEqual({ stop: 'conflict' })
    expect(h.pending()).toEqual({ patch: { lossLimit: 500 }, editedAt: 'F' })
  })

  it('a server failure that passes keeps the patch for the next try', async () => {
    const h = settingsHarness(patch, async () => {
      throw describeError({ message: 'Service Unavailable' }, 503)
    })
    expect(await pushSettings(h.hooks)).toMatchObject({ stop: 'retry' })
    expect(h.pending()).toBe(patch)
  })

  it('keeps the patch when the server is unreachable', async () => {
    const h = settingsHarness(patch, async () => {
      throw offline()
    })
    expect(await pushSettings(h.hooks)).toEqual({ stop: 'offline' })
    expect(h.pending()).toBe(patch)
  })

  it('keeps the patch when the session has ended', async () => {
    const h = settingsHarness(patch, async () => {
      throw new SignedOutError()
    })
    expect(await pushSettings(h.hooks)).toMatchObject({ stop: 'paused' })
    expect(h.pending()).toBe(patch)
  })

  it('keeps the patch when the database is missing a migration', async () => {
    const h = settingsHarness(patch, async () => {
      throw new MigrationNeededError()
    })
    const out = await pushSettings(h.hooks)
    expect(out?.stop).toBe('behind')
    expect(h.pending()).toBe(patch)
  })

  it('drops the patch when the server refuses it for good', async () => {
    const h = settingsHarness(patch, async () => {
      throw refused()
    })
    const out = await pushSettings(h.hooks)
    expect(out?.stop).toBe('rejected')
    expect(h.pending()).toBeNull()
  })
})

describe('syncStatus — the badge', () => {
  const at = (over: Partial<Parameters<typeof syncStatus>[0]>) => syncStatus({ canSync: true, offline: false, queued: 0, behind: false, ...over })

  it('says offline first, with no session or no connection', () => {
    expect(at({ canSync: false, queued: 2, behind: true })).toBe('offline')
    expect(at({ offline: true, queued: 2, behind: true })).toBe('offline')
  })

  it('says synced when nothing is queued, whatever happened before', () => {
    expect(at({ behind: true })).toBe('synced')
  })

  it('says behind when the queue waits on a migration, syncing otherwise', () => {
    expect(at({ queued: 1, behind: true })).toBe('behind')
    expect(at({ queued: 1 })).toBe('syncing')
  })
})

describe('combinedStatus — one badge for several queues', () => {
  it('is what the bets say when nothing else is queued', () => {
    for (const s of ['synced', 'syncing', 'offline', 'behind'] as const) expect(combinedStatus([s, 'synced'])).toBe(s)
  })

  it('says behind when only a held-back queue waits', () => {
    expect(combinedStatus(['synced', 'behind'])).toBe('behind')
  })

  it('puts offline first, then a queue on its way, then one held back', () => {
    expect(combinedStatus(['behind', 'offline'])).toBe('offline')
    expect(combinedStatus(['syncing', 'behind'])).toBe('syncing')
    expect(combinedStatus(['behind', 'syncing', 'synced'])).toBe('syncing')
    expect(combinedStatus(['synced', 'synced', 'synced'])).toBe('synced')
  })
})

describe('afterFailedRead — what a failed read of the moves leaves on screen', () => {
  const cached = [{ id: 'm' }]
  const noTable = () => describeError({ message: "Could not find the table 'public.bankroll_moves' in the schema cache" })

  it('keeps the device copy when the server is unreachable, says offline, reports nothing', () => {
    expect(afterFailedRead(offline(), cached)).toEqual({ offline: true, server: cached, tableMissing: false, report: false })
    // Never loaded on this device: still nothing known.
    expect(afterFailedRead(offline(), null)).toEqual({ offline: true, server: null, tableMissing: false, report: false })
  })

  it('reads a missing table as no moves yet, keeps a device copy from before, and reports nothing', () => {
    expect(afterFailedRead(noTable(), null)).toEqual({ offline: false, server: [], tableMissing: true, report: false })
    expect(afterFailedRead(noTable(), cached)).toEqual({ offline: false, server: cached, tableMissing: true, report: false })
    // As Postgres words it, before PostgREST reads the error.
    expect(afterFailedRead(new Error('relation "public.bankroll_moves" does not exist'), null).tableMissing).toBe(true)
  })

  it('reports any other refusal and keeps the device copy', () => {
    expect(afterFailedRead(refused(), cached)).toEqual({ offline: false, server: cached, tableMissing: false, report: true })
    expect(afterFailedRead(refused(), null)).toEqual({ offline: false, server: null, tableMissing: false, report: true })
  })
})

describe('the queue rules on deposits and withdrawals', () => {
  const addMv = (id: string, amount: number): MoveOp => ({ opId: `add-${id}`, kind: 'add', id, input: { date: '2026-03-01', amount }, queuedAt: 'Q' })
  const editMv = (id: string, amount: number, editedAt: string): MoveOp => ({ opId: `edit-${id}-${editedAt}`, kind: 'update', id, input: { date: '2026-03-01', amount, note: 'fixed' }, editedAt })
  const delMv = (id: string): MoveOp => ({ opId: `del-${id}`, kind: 'delete', id })
  const row = (op: Extract<MoveOp, { kind: 'add' }>): BankrollMove => ({ id: op.id, date: op.input.date, amount: op.input.amount, note: op.input.note ?? '', createdAt: op.queuedAt, updatedAt: insertStamp(op) })

  it('folds an edit into a queued add, which then carries the edit time', () => {
    const out = enqueueOp<MoveInput>([addMv('a', 500)], editMv('a', 450, 'E'))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'add', input: { amount: 450, note: 'fixed' }, editedAt: 'E' })
    expect(applyMoveOutbox([], out)[0]).toMatchObject({ amount: 450, updatedAt: 'E' })
  })

  it('cancels an add that never went out when it is deleted, and sends a delete after a sent one', () => {
    expect(enqueueOp<MoveInput>([addMv('a', 500)], delMv('a'))).toEqual([])
    const sent: MoveOp = { ...addMv('a', 500), sent: true }
    expect(enqueueOp<MoveInput>([sent], delMv('a'))).toEqual([sent, delMv('a')])
  })

  it('drains moves in order, folding each answer into the server state', async () => {
    let queue: MoveOp[] = [addMv('a', 500), addMv('b', -120.5), delMv('a')]
    let server: BankrollMove[] = []
    const hooks: DrainHooks<MoveInput, BankrollMove> = {
      outbox: () => queue,
      update: (fn) => (queue = fn(queue)),
      send: async (op) => (op.kind === 'add' ? row(op) : null),
      applied: (op, result) => {
        server = reconcileMove(server, op, result)
      },
      rejected: () => {}
    }
    expect(await drainOutbox<MoveInput, BankrollMove>(hooks)).toEqual({ stop: 'done', processed: 3 })
    expect(server.map((m) => [m.id, m.amount])).toEqual([['b', -120.5]])
    expect(queue).toEqual([])
  })

  it('keeps every move queued while the table is missing', async () => {
    let queue: MoveOp[] = [addMv('a', 500), editMv('a', 400, 'E')]
    const hooks: DrainHooks<MoveInput, BankrollMove> = {
      outbox: () => queue,
      update: (fn) => (queue = fn(queue)),
      send: async () => {
        throw describeError({ message: "Could not find the table 'public.bankroll_moves' in the schema cache" })
      },
      applied: () => {},
      rejected: () => {}
    }
    const out = await drainOutbox<MoveInput, BankrollMove>(hooks)
    expect(out.stop).toBe('behind')
    expect(queue.map((o) => o.opId)).toEqual(['add-a', 'edit-a-E'])
    // Refused before it could apply: still cancellable.
    expect(queue[0].sent).toBeUndefined()
  })
})

describe('migrationNotice — the hint once per episode', () => {
  it('is new only the first time, until it is cleared', () => {
    const n = migrationNotice()
    expect(n.active).toBe(false)
    expect(n.found()).toBe(true)
    expect(n.found()).toBe(false) // a retry
    expect(n.found()).toBe(false) // a resume
    expect(n.active).toBe(true)
    n.clear() // a request went through, or the queue emptied
    expect(n.active).toBe(false)
    expect(n.found()).toBe(true)
  })
})

/**
 * The user keeps working while a request is out: a drain sends the op at the
 * head of the queue, and before the server answers, the app can queue more
 * ops through enqueueOp. These run the real enqueueOp against a fake server
 * with the real rules (an insert is stamped with insertStamp, an update lands
 * only when updated_at <= editedAt, a duplicate insert returns the row that
 * is there) whose answers the test releases by hand, and whose requests can
 * fail every way a real one can.
 */
describe('drainOutbox — changes made while a request is out', () => {
  type Row = { amount: number | null; note: string; updatedAt: string }
  type Failure = 'offline' | 'behind' | 'refused' | 'landed-then-offline'

  function setup(initialServer: Record<string, { amount: number | null; note: string; updatedAt?: string }>, initialQueue: PendingOp[]) {
    const server = new Map<string, Row>(Object.entries(initialServer).map(([id, r]) => [id, { updatedAt: 'T00', ...r }]))
    let queue = [...initialQueue]
    const paused = new Map<string, () => void>()
    let pauseNext: string | null = null
    const failures = new Map<string, Failure>()
    const reached: string[] = []
    const conflicts: string[] = []
    const notices: string[] = []
    const rejected: string[] = []

    const row = (input: { amount?: number | null; note?: string }, updatedAt: string): Row => ({ amount: input.amount ?? null, note: input.note ?? '', updatedAt })
    // Like the real calls: an add or an update that lands returns the row, a
    // refused update returns null.
    const stored = (id: string): Bet => bet({ id, note: server.get(id)?.note })
    const apply = (op: PendingOp): Bet | null => {
      if (op.kind === 'add') {
        if (!server.has(op.id)) server.set(op.id, row(op.input, insertStamp(op)))
        return stored(op.id)
      }
      if (op.kind === 'bulk-add') {
        for (const e of op.entries) server.set(e.id, row(e.input, insertStamp(op)))
        return null
      }
      if (op.kind === 'update') {
        const current = server.get(op.id)
        if (!current || current.updatedAt > op.editedAt) {
          conflicts.push(op.opId)
          return null
        }
        server.set(op.id, row(op.input, op.editedAt))
        return stored(op.id)
      }
      server.delete(op.id)
      return null
    }

    const hooks: DrainHooks = {
      outbox: () => queue,
      update: (fn) => (queue = fn(queue)),
      send: async (op) => {
        if (op.opId === pauseNext) {
          pauseNext = null
          await new Promise<void>((resolve) => paused.set(op.opId, resolve))
        }
        reached.push(op.opId)
        const failure = failures.get(op.opId)
        failures.delete(op.opId)
        if (failure === 'offline') throw new TypeError('Failed to fetch')
        if (failure === 'behind') throw new MigrationNeededError()
        if (failure === 'refused') throw new Error('new row violates row-level security policy')
        const result = apply(op)
        if (failure === 'landed-then-offline') throw new TypeError('Failed to fetch')
        return result
      },
      // As useBetSync: a refused update says "a newer edit elsewhere was kept"
      // unless a later change of this device for the bet is still queued.
      applied: (op, result, superseded) => {
        if (op.kind === 'update' && result === null && !superseded) notices.push(op.opId)
      },
      rejected: (ops) => void rejected.push(...ops.map((o) => o.opId))
    }

    return {
      server,
      hooks,
      queue: () => queue,
      reached,
      conflicts,
      notices,
      rejected,
      /** What the user sees: the server's rows with the queue applied on top. */
      view: () =>
        applyOutbox(
          [...server].map(([id, r]) => bet({ id, amount: r.amount, note: r.note, status: r.amount === null ? 'pending' : undefined })),
          queue
        ).map((b) => [b.id, b.note]),
      /** What the hook does when the user acts. */
      user: (op: PendingOp) => {
        queue = enqueueOp(queue, op)
      },
      /** Make the next request for `opId` fail this way. */
      fail: (opId: string, how: Failure) => void failures.set(opId, how),
      /** A plain drain, run to its end. */
      drain: () => drainOutbox(hooks),
      /** Start a drain that stops inside the request for `opId`; resolves once it is out. */
      startPausedAt: async (opId: string) => {
        pauseNext = opId
        const drain = drainOutbox(hooks)
        await vi.waitFor(() => expect(paused.has(opId)).toBe(true))
        return {
          finish: async () => {
            paused.get(opId)?.()
            return drain
          }
        }
      }
    }
  }

  // Times are compared as strings, like ISO timestamps: T00 < T01 < T1 < T2 < T50…
  const addOp = (id: string, note: string): PendingOp => ({ opId: `add-${id}-${note}`, kind: 'add', id, input: { date: '2026-03-01', amount: 5, note }, queuedAt: 'T01' })
  const editOp = (id: string, note: string, editedAt = `T50-${note}`): PendingOp => ({ opId: `edit-${id}-${note}`, kind: 'update', id, input: { date: '2026-03-01', amount: 5, note }, editedAt })
  const delOp = (id: string): PendingOp => ({ opId: `del-${id}`, kind: 'delete', id })

  it('an edit made while its add is being sent reaches the server', async () => {
    const t = setup({}, [addOp('a', 'v1')])
    const drain = await t.startPausedAt('add-a-v1')
    t.user(editOp('a', 'v2'))
    await drain.finish()
    expect(t.server.get('a')?.note).toBe('v2')
    expect(t.queue()).toEqual([])
  })

  it('an edit made while an earlier edit is being sent reaches the server', async () => {
    const t = setup({ a: { amount: 5, note: 'v0' } }, [editOp('a', 'v1')])
    const drain = await t.startPausedAt('edit-a-v1')
    t.user(editOp('a', 'v2'))
    await drain.finish()
    expect(t.server.get('a')?.note).toBe('v2')
    expect(t.queue()).toEqual([])
  })

  it('deleting a bet while its add is being sent deletes it, and loses nothing else', async () => {
    const t = setup({}, [addOp('a', 'v1'), addOp('b', 'v1')])
    const drain = await t.startPausedAt('add-a-v1')
    t.user(delOp('a'))
    await drain.finish()
    expect([...t.server.keys()]).toEqual(['b'])
    expect(t.queue()).toEqual([])
  })

  it('deleting a bet while an edit of it is being sent deletes it, and loses nothing else', async () => {
    const t = setup({ a: { amount: 5, note: 'v0' } }, [editOp('a', 'v1'), addOp('c', 'v1')])
    const drain = await t.startPausedAt('edit-a-v1')
    t.user(delOp('a'))
    await drain.finish()
    expect([...t.server.keys()].sort()).toEqual(['c'])
    expect(t.queue()).toEqual([])
  })

  it('an Undo of a bulk settle made while the settle is being sent puts every bet back', async () => {
    const t = setup(
      { a: { amount: null, note: 'open' }, b: { amount: null, note: 'open' } },
      [editOp('a', 'settled', 'T11'), editOp('b', 'settled', 'T11')]
    )
    const drain = await t.startPausedAt('edit-a-settled')
    t.user(editOp('a', 'open', 'T12'))
    t.user(editOp('b', 'open', 'T12'))
    await drain.finish()
    expect(t.server.get('a')?.note).toBe('open')
    expect(t.server.get('b')?.note).toBe('open')
    expect(t.queue()).toEqual([])
  })

  it('an edit made after a sent add failed, with an edit already behind it, is the one that lands', async () => {
    for (const how of ['offline', 'behind'] as const) {
      const t = setup({}, [addOp('a', 'v1')])
      t.fail('add-a-v1', how)
      const drain = await t.startPausedAt('add-a-v1')
      t.user(editOp('a', 'v2', 'T2'))
      expect((await drain.finish()).stop).toBe(how)
      // Nothing is on the wire now; the user edits again.
      t.user(editOp('a', 'v3', 'T3'))
      expect(t.view()).toEqual([['a', 'v3']])
      expect((await t.drain()).stop).toBe('done')
      expect(t.server.get('a')?.note).toBe('v3')
      expect(t.queue()).toEqual([])
    }
  })

  it('an edit made after a sent edit failed lands, with no false conflict', async () => {
    const t = setup({ a: { amount: 5, note: 'v0' } }, [editOp('a', 'v1', 'T1')])
    t.fail('edit-a-v1', 'offline')
    const drain = await t.startPausedAt('edit-a-v1')
    t.user(editOp('a', 'v2', 'T2'))
    await drain.finish()
    t.user(editOp('a', 'v3', 'T3'))
    expect(t.view()).toEqual([['a', 'v3']])
    await t.drain()
    expect(t.server.get('a')?.note).toBe('v3')
    expect(t.conflicts).toEqual([])
  })

  it('a bet whose add landed but whose answer was lost is deleted, not brought back', async () => {
    const t = setup({}, [addOp('a', 'v1')])
    t.fail('add-a-v1', 'landed-then-offline')
    expect((await t.drain()).stop).toBe('offline')
    t.user(delOp('a'))
    await t.drain()
    expect(t.server.has('a')).toBe(false)
    expect(t.queue()).toEqual([])
  })

  it('an edit of a bet whose add landed but whose answer was lost reaches the server', async () => {
    const t = setup({}, [addOp('a', 'v1')])
    t.fail('add-a-v1', 'landed-then-offline')
    await t.drain()
    t.user(editOp('a', 'v2', 'T2'))
    await t.drain() // the add again (already there: the row comes back), then the edit
    expect(t.server.get('a')?.note).toBe('v2')
    expect(t.conflicts).toEqual([])
  })

  it('a refused add takes the edits queued for its bet with it, with no false conflict', async () => {
    const t = setup({}, [addOp('a', 'v1'), addOp('b', 'v1')])
    t.fail('add-a-v1', 'refused')
    const drain = await t.startPausedAt('add-a-v1')
    t.user(editOp('a', 'v2', 'T2'))
    expect((await drain.finish()).stop).toBe('done')
    // Both leave the queue together, and are kept together to be sent again.
    expect(t.rejected).toEqual(['add-a-v1', 'edit-a-v2'])
    expect(t.conflicts).toEqual([])
    expect([...t.server.keys()]).toEqual(['b'])
    expect(t.queue()).toEqual([])
  })

  // Storage full: store.ts replays the changes made since on the queue as
  // stored when it takes them again. The refusal's change computed what to
  // take out on whatever queue it got, so a replay took out more.
  it('decides once what a refusal takes out: replayed on a later queue, it takes the same ops', async () => {
    const t = setup({}, [addOp('a', 'v1')])
    const changes: ((q: PendingOp[]) => PendingOp[])[] = []
    const update = t.hooks.update
    t.hooks.update = (fn) => {
      changes.push(fn)
      return update(fn)
    }
    t.fail('add-a-v1', 'refused')
    await t.drain()
    expect(t.rejected).toEqual(['add-a-v1'])
    const stored = [addOp('a', 'v1'), editOp('a', 'v2', 'T2'), addOp('b', 'v1')]
    expect(changes[changes.length - 1](stored).map((o) => o.opId)).toEqual(['edit-a-v2', 'add-b-v1'])
  })

  it('a refused add takes the delete queued behind it but not an Undo after that, so the restored bet is kept', async () => {
    const t = setup({}, [addOp('a', 'v1')])
    t.fail('add-a-v1', 'refused')
    const drain = await t.startPausedAt('add-a-v1')
    // Deleted, then restored with Undo, while the add is out.
    t.user(delOp('a'))
    t.user({ opId: 'restore-a', kind: 'add', id: 'a', input: { date: '2026-03-01', amount: 5, note: 'restored' }, queuedAt: 'T03' })
    t.user(editOp('a', 'restored and edited', 'T04'))
    await drain.finish()
    expect(t.rejected).toEqual(['add-a-v1', 'del-a'])
    expect(t.server.get('a')?.note).toBe('restored and edited')
    expect(t.queue()).toEqual([])
  })

  // The delete stayed and went out as a no-op, the refused entry held the add
  // alone, and "Send again" made the bet the user had deleted.
  it('a refused add takes the delete queued behind it: sent again, the two are nothing', async () => {
    const t = setup({}, [addOp('a', 'v1')])
    t.fail('add-a-v1', 'refused')
    const drain = await t.startPausedAt('add-a-v1')
    t.user(delOp('a'))
    await drain.finish()
    expect(t.rejected).toEqual(['add-a-v1', 'del-a'])
    const story = [addOp('a', 'v1'), delOp('a')].map((o) => ({ ...o, opId: `again-${o.opId}` }))
    expect(requeueRefused([], [story])).toEqual([])
  })

  it('an add refused after an earlier attempt that may have landed keeps the edits queued for it', async () => {
    const t = setup({}, [addOp('a', 'v1')])
    t.fail('add-a-v1', 'landed-then-offline')
    expect((await t.drain()).stop).toBe('offline')
    t.user(editOp('a', 'v2', 'T2'))
    // The retry is refused (an expired session, say), but the first attempt made the bet.
    t.fail('add-a-v1', 'refused')
    await t.drain()
    expect(t.rejected).toEqual(['add-a-v1'])
    expect(t.server.get('a')?.note).toBe('v2')
    expect(t.notices).toEqual([])
  })

  it('a refused import keeps the edits queued for its rows: an earlier chunk may have landed', async () => {
    // Its first chunk is on the server; the request for the rest was refused.
    const t = setup({ x: { amount: 5, note: 'imported', updatedAt: 'T1' } }, [
      { opId: 'imp', kind: 'bulk-add', entries: [{ id: 'x', input: { date: '2026-03-01', amount: 5, note: 'imported' } }], queuedAt: 'T1' }
    ])
    t.fail('imp', 'refused')
    const drain = await t.startPausedAt('imp')
    t.user(editOp('x', 'settled', 'T2'))
    await drain.finish()
    expect(t.rejected).toEqual(['imp'])
    expect(t.server.get('x')?.note).toBe('settled')
    expect(t.queue()).toEqual([])
  })

  it('an add the database turned away on its first attempt never went out: deleting it cancels it', async () => {
    const t = setup({}, [addOp('a', 'v1')])
    t.fail('add-a-v1', 'behind')
    expect((await t.drain()).stop).toBe('behind')
    expect(t.queue()[0].sent).toBeUndefined()
    t.user(delOp('a'))
    expect(t.queue()).toEqual([])
  })

  it('an add turned away after an earlier attempt that may have landed stays sent: deleting it sends a delete', async () => {
    const t = setup({}, [addOp('a', 'v1')])
    t.fail('add-a-v1', 'landed-then-offline')
    await t.drain()
    t.fail('add-a-v1', 'behind')
    expect((await t.drain()).stop).toBe('behind')
    expect(t.queue()[0].sent).toBe(true)
    t.user(delOp('a'))
    await t.drain()
    expect(t.server.has('a')).toBe(false)
    expect(t.queue()).toEqual([])
  })

  it('an edit refused while a later edit of the same bet is queued says nothing; that later edit has the last word', async () => {
    const t = setup({ a: { amount: 5, note: 'v0' } }, [editOp('a', 'v1', 'T1')])
    const drain = await t.startPausedAt('edit-a-v1')
    // Another device saves at T5 while the request is out; this device edits again at T9.
    t.server.set('a', { amount: 5, note: 'theirs', updatedAt: 'T5' })
    t.user(editOp('a', 'v2', 'T9'))
    await drain.finish()
    expect(t.conflicts).toEqual(['edit-a-v1'])
    expect(t.notices).toEqual([])
    expect(t.server.get('a')?.note).toBe('v2')
  })

  it('an edit refused with nothing of this device queued after it says a newer edit was kept', async () => {
    const t = setup({ a: { amount: 5, note: 'theirs', updatedAt: 'T5' } }, [editOp('a', 'v1', 'T1'), addOp('b', 'v1')])
    await t.drain()
    expect(t.notices).toEqual(['edit-a-v1'])
    expect(t.server.get('a')?.note).toBe('theirs')
  })

  it('an edit of an imported row made while the import is out lands after it', async () => {
    const t = setup({}, [{ opId: 'imp', kind: 'bulk-add', entries: [{ id: 'x', input: { date: '2026-03-01', amount: 5, note: 'imported' } }], queuedAt: 'T1' }])
    const drain = await t.startPausedAt('imp')
    t.user(editOp('x', 'settled', 'T2'))
    await drain.finish()
    expect(t.server.get('x')?.note).toBe('settled')
    expect(t.conflicts).toEqual([])
  })

  it('a restored bet edited before it syncs carries that edit\'s time, so an older edit from elsewhere loses', async () => {
    // Deleted, restored with Undo at T03, then edited at T10, all before syncing.
    const restore: PendingOp = { opId: 'restore-a', kind: 'add', id: 'a', input: { date: '2026-03-01', amount: 5, note: 'restored' }, queuedAt: 'T03' }
    const t = setup({ a: { amount: 5, note: 'v0', updatedAt: 'T01' } }, [delOp('a'), restore])
    t.user(editOp('a', 'mine', 'T10'))
    await t.drain()
    // Another device's edit made offline at T04 arrives now.
    t.user(editOp('a', 'theirs', 'T04'))
    await t.drain()
    expect(t.server.get('a')?.note).toBe('mine')
    expect(t.conflicts).toEqual(['edit-a-theirs'])
  })

  it('removes the op it sent by its opId, even when another op is first by then', async () => {
    const t = setup({}, [addOp('a', 'v1')])
    const drain = await t.startPausedAt('add-a-v1')
    // Something puts another op at the head while the request is out.
    t.hooks.update((q) => [addOp('z', 'v1'), ...q])
    await drain.finish()
    expect(t.reached.filter((id) => id === 'add-a-v1')).toHaveLength(1)
    expect([...t.server.keys()].sort()).toEqual(['a', 'z'])
    expect(t.queue()).toEqual([])
  })

  it('removes the op it sent, not whatever is first in the queue by then', async () => {
    const t = setup({}, [addOp('a', 'v1'), addOp('b', 'v1'), addOp('c', 'v1')])
    const drain = await t.startPausedAt('add-a-v1')
    t.user(delOp('a'))
    await drain.finish()
    expect(t.reached).toContain('add-b-v1')
    expect([...t.server.keys()].sort()).toEqual(['b', 'c'])
  })
})

describe('foldApplied — a row back from the server before any snapshot', () => {
  const add = (rows: readonly string[]): string[] => [...rows, 'new']

  it('folds into the snapshot when this device has one', () => {
    expect(foldApplied(['a'], [], add)).toEqual({ server: ['a', 'new'], landed: [] })
  })

  it('keeps it apart when there is none: one row is not the whole list', () => {
    expect(foldApplied<string>(null, [], add)).toEqual({ server: null, landed: ['new'] })
    expect(foldApplied<string>(null, ['earlier'], add)).toEqual({ server: null, landed: ['earlier', 'new'] })
  })
})

describe('retryPlan — the slow timer', () => {
  it('reads while nothing has been read yet, queued or not', () => {
    expect(retryPlan({ queued: false, loaded: false })).toBe('read')
    expect(retryPlan({ queued: true, loaded: false })).toBe('read')
  })

  it('reads while the table was last found missing, to notice the migration', () => {
    expect(retryPlan({ queued: false, loaded: true, tableMissing: true })).toBe('read')
  })

  it('only sends when loaded and something is queued, and otherwise rests', () => {
    expect(retryPlan({ queued: true, loaded: true })).toBe('drain')
    expect(retryPlan({ queued: false, loaded: true })).toBe('idle')
    expect(retryPlan({ queued: false, loaded: true, tableMissing: false })).toBe('idle')
  })
})
