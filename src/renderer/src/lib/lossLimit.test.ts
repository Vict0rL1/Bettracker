import { beforeEach, describe, expect, it } from 'vitest'
import { dismissKey, loadLossDismissed, lossState, saveLossDismissed } from './lossLimit'

beforeEach(() => localStorage.clear())

describe('lossState', () => {
  it('is quiet without a limit, or while the month is up', () => {
    expect(lossState(-900, null).level).toBe('none')
    expect(lossState(-900, 0).level).toBe('none')
    expect(lossState(120, 500)).toMatchObject({ level: 'none', loss: 0, ratio: 0 })
  })

  it('warns at 80% of the limit and again once past it', () => {
    expect(lossState(-399.99, 500).level).toBe('none')
    expect(lossState(-400, 500)).toMatchObject({ level: 'near', loss: 400, ratio: 0.8 })
    expect(lossState(-499.99, 500).level).toBe('near')
    expect(lossState(-500, 500)).toMatchObject({ level: 'over', ratio: 1 })
    expect(lossState(-1250, 500)).toMatchObject({ level: 'over', loss: 1250, ratio: 2.5 })
  })
})

describe('dismissing the banner', () => {
  it('is remembered per month and level', () => {
    const key = dismissKey({ year: 2026, month: 9 }, 'near')
    expect(key).toBe('2026-10:near')
    expect(loadLossDismissed()).toBeNull()
    saveLossDismissed(key)
    expect(loadLossDismissed()).toBe(key)
    expect(dismissKey({ year: 2026, month: 9 }, 'over')).not.toBe(key)
    expect(dismissKey({ year: 2026, month: 10 }, 'near')).not.toBe(key)
  })
})
