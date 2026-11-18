import { beforeEach, describe, expect, it } from 'vitest'
import { loadExpenseLast, saveExpenseLast } from './expenseLast'
import { clearUserData, markSignedIn } from './offline'

beforeEach(() => {
  localStorage.clear()
  for (const uid of ['u1', 'u2']) markSignedIn(uid)
})

describe('the card and category the expense sheet last used', () => {
  it('round trips per user, under its own key', () => {
    expect(loadExpenseLast('u1')).toBeNull()
    saveExpenseLast('u1', { cardId: 'c1', category: 'coffee' })
    saveExpenseLast('u2', { cardId: null, category: 'food' })
    expect(loadExpenseLast('u1')).toEqual({ cardId: 'c1', category: 'coffee' })
    expect(loadExpenseLast('u2')).toEqual({ cardId: null, category: 'food' })
    expect(localStorage.getItem('bettracker:expense-last:u1')).toBe('{"cardId":"c1","category":"coffee"}')
  })

  it('reads a shape it does not know as nothing', () => {
    for (const raw of ['junk', '[]', '{"cardId":"c1"}', '{"cardId":3,"category":"coffee"}', '{"cardId":"c1","category":"fuel"}', '{"cardId":"","category":"coffee"}']) {
      localStorage.setItem('bettracker:expense-last:u1', raw)
      expect(loadExpenseLast('u1'), raw).toBeNull()
    }
  })

  it('goes with the rest on sign-out, and is not written back meanwhile', () => {
    saveExpenseLast('u2', { cardId: 'c1', category: 'coffee' })
    clearUserData('u2')
    expect(loadExpenseLast('u2')).toBeNull()
    saveExpenseLast('u2', { cardId: 'c1', category: 'coffee' })
    expect(localStorage.getItem('bettracker:expense-last:u2')).toBeNull()
  })
})
