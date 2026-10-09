import { describe, expect, it, vi } from 'vitest'
import type { Bet, Settings } from '../../../shared/types'
import { DEFAULT_SETTINGS } from '../../../shared/types'
import { bet } from '../test-utils'
import { drainOutbox, migrationNotice, pushSettings, syncStatus, type DrainHooks } from './drain'
import { MigrationNeededError } from './errors'
import { applyOutbox, enqueueOp, insertStamp, type PendingOp, type PendingSettings } from './offline'

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
    setOutbox: (next) => {
      queue = next
    },
    markSent: () => {},
    send: (op) => {
      sent.push(op.opId)
      return send(op)
    },
    applied: (op) => void applied.push(op.opId),
    rejected: (op) => void rejected.push(op.opId)
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
      if (op.opId === 'op-a') h.hooks.setOutbox([...h.hooks.outbox(), add('d')])
      return bet()
    })
    expect(await drainOutbox(h.hooks)).toEqual({ stop: 'done', processed: 2 })
    expect(h.sent).toEqual(['op-a', 'op-d'])
    expect(h.queue()).toEqual([])
  })

  it('keeps an op queued while a request is out when that request finds the database behind', async () => {
    let h: ReturnType<typeof harness>
    h = harness([add('a')], async () => {
      h.hooks.setOutbox([...h.hooks.outbox(), add('d')])
      throw new MigrationNeededError()
    })
    expect((await drainOutbox(h.hooks)).stop).toBe('behind')
    expect(h.queue()).toEqual(['op-a', 'op-d'])
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
        setPending: (next: PendingSettings | null) => {
          pending = next
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
    expect(h.pending()).toBe(merged)
  })

  it('keeps the patch when the server is unreachable', async () => {
    const h = settingsHarness(patch, async () => {
      throw offline()
    })
    expect(await pushSettings(h.hooks)).toEqual({ stop: 'offline' })
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
    const rejected: string[] = []

    const row = (input: { amount?: number | null; note?: string }, updatedAt: string): Row => ({ amount: input.amount ?? null, note: input.note ?? '', updatedAt })
    const apply = (op: PendingOp): Bet | null => {
      if (op.kind === 'add') {
        if (!server.has(op.id)) server.set(op.id, row(op.input, insertStamp(op)))
      } else if (op.kind === 'bulk-add') {
        for (const e of op.entries) server.set(e.id, row(e.input, insertStamp(op)))
      } else if (op.kind === 'update') {
        const current = server.get(op.id)
        if (!current || current.updatedAt > op.editedAt) {
          conflicts.push(op.opId)
          return null
        }
        server.set(op.id, row(op.input, op.editedAt))
      } else server.delete(op.id)
      return null
    }

    const hooks: DrainHooks = {
      outbox: () => queue,
      setOutbox: (next) => {
        queue = next
      },
      markSent: (op) => {
        queue = queue.map((o) => (o.opId === op.opId ? { ...o, sent: true } : o))
      },
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
      applied: () => {},
      rejected: (op) => void rejected.push(op.opId)
    }

    return {
      server,
      hooks,
      queue: () => queue,
      reached,
      conflicts,
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
    expect(t.rejected).toEqual(['add-a-v1'])
    expect(t.conflicts).toEqual([])
    expect([...t.server.keys()]).toEqual(['b'])
    expect(t.queue()).toEqual([])
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
    t.hooks.setOutbox([addOp('z', 'v1'), ...t.queue()])
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
