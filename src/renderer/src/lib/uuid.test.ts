import { afterEach, describe, expect, it, vi } from 'vitest'
import { newId } from './uuid'

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

afterEach(() => vi.unstubAllGlobals())

describe('newId', () => {
  it("uses the browser's own randomUUID where there is one", () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'own', getRandomValues: () => undefined })
    expect(newId()).toBe('own')
  })

  it('makes version 4 UUIDs, a new one each time, where the browser offers none (plain http on the LAN)', () => {
    const real = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: <T extends ArrayBufferView>(a: T) => real.getRandomValues(a as unknown as Uint8Array) as unknown as T })
    const ids = Array.from({ length: 200 }, newId)
    for (const id of ids) expect(id).toMatch(V4)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
