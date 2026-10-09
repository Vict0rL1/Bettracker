import { describe, expect, it } from 'vitest'
import type { Bet, Settings } from '../../../shared/types'
import { DEFAULT_SETTINGS } from '../../../shared/types'
import { bet } from '../test-utils'
import { drainOutbox, migrationNotice, pushSettings, syncStatus, type DrainHooks } from './drain'
import { MigrationNeededError } from './errors'
import type { PendingOp, PendingSettings } from './offline'

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
