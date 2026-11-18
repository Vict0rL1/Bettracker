import { describe, expect, it } from 'vitest'
import { drainTurns } from './oneAtATime'

describe('drainTurns', () => {
  it('one drain at a time; a call while one is out asks for exactly one more after it', () => {
    const turns = drainTurns<string>()
    expect(turns.start('u1')).toBe(true)
    // A reconnect and a resume while it is out: neither starts one, and neither is dropped.
    expect(turns.start('u1')).toBe(false)
    expect(turns.start('u1')).toBe(false)
    expect(turns.end('u1')).toBe(true)
    // The one more.
    expect(turns.start('u1')).toBe(true)
    expect(turns.end('u1')).toBe(false)
  })

  it('a drain with no call meanwhile asks for nothing more', () => {
    const turns = drainTurns<string>()
    expect(turns.start('u1')).toBe(true)
    expect(turns.end('u1')).toBe(false)
    expect(turns.start('u1')).toBe(true)
    expect(turns.end('u1')).toBe(false)
  })

  it('another user’s drain starts at once, and a late end of the old one neither frees nor reruns it', () => {
    const turns = drainTurns<string>()
    expect(turns.start('u1')).toBe(true)
    expect(turns.start('u2')).toBe(true)
    // u1's drain ends late: u2's is still out.
    expect(turns.end('u1')).toBe(false)
    expect(turns.start('u2')).toBe(false)
    expect(turns.end('u2')).toBe(true)
  })

  it('a call for the old user while the new one drains is not the new one’s', () => {
    const turns = drainTurns<string>()
    expect(turns.start('u1')).toBe(true)
    expect(turns.start('u2')).toBe(true)
    expect(turns.start('u2')).toBe(false)
    expect(turns.end('u2')).toBe(true)
    expect(turns.end('u1')).toBe(false)
  })
})
