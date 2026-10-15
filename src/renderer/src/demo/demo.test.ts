import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEMO_USER, ensureRandomUUID, randomUUID, resetDemo } from './demo'

beforeEach(() => localStorage.clear())

describe('resetDemo', () => {
  it("empties the fake server and the demo user's copy on this device, and nothing else", () => {
    const uid = DEMO_USER.id
    const demoKeys = ['demo:rows', 'demo:moves', 'demo:settings', 'demo:signed-out', 'demo:migrated']
    const userKeys = [
      `bettracker:cache:${uid}`,
      `bettracker:outbox:${uid}`,
      `bettracker:settings:${uid}`,
      `bettracker:settings-outbox:${uid}`,
      `bettracker:moves:${uid}`,
      `bettracker:moves-outbox:${uid}`,
      'bettracker:last-user'
    ]
    const kept = ['bettracker:theme', 'bettracker:lang', 'e2e:rows', 'bettracker:cache:someone-else']
    for (const k of [...demoKeys, ...userKeys, ...kept]) localStorage.setItem(k, '1')

    resetDemo()

    for (const k of [...demoKeys, ...userKeys]) expect(localStorage.getItem(k), k).toBeNull()
    for (const k of kept) expect(localStorage.getItem(k), k).toBe('1')
  })
})

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('randomUUID', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('makes version 4 UUIDs, a new one each time', () => {
    const ids = Array.from({ length: 200 }, randomUUID)
    for (const id of ids) expect(id).toMatch(V4)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("is supplied where the browser hides crypto's own (plain http on the LAN)", () => {
    const real = globalThis.crypto
    const insecure: { getRandomValues: Crypto['getRandomValues']; randomUUID?: () => string } = {
      getRandomValues: (a) => real.getRandomValues(a)
    }
    vi.stubGlobal('crypto', insecure)
    ensureRandomUUID()
    expect(insecure.randomUUID?.()).toMatch(V4)
  })

  it("leaves the browser's own alone", () => {
    const own = (): string => 'own'
    vi.stubGlobal('crypto', { getRandomValues: () => undefined, randomUUID: own })
    ensureRandomUUID()
    expect((globalThis.crypto as unknown as { randomUUID: () => string }).randomUUID).toBe(own)
  })
})
