import { beforeEach, describe, expect, it } from 'vitest'
import { loadExpenseLast, rememberPayCurrency, saveExpenseLast } from './expenseLast'
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

  describe('the other currency last paid in', () => {
    it('is kept with them, and stays when the next expense is in the main currency', () => {
      saveExpenseLast('u1', { cardId: 'c1', category: 'coffee', currency: 'USD' })
      expect(loadExpenseLast('u1')).toEqual({ cardId: 'c1', category: 'coffee', currency: 'USD' })
      saveExpenseLast('u1', { cardId: null, category: 'food' })
      expect(loadExpenseLast('u1')).toEqual({ cardId: null, category: 'food', currency: 'USD' })
      saveExpenseLast('u1', { cardId: null, category: 'food', currency: 'EUR' })
      expect(loadExpenseLast('u1')?.currency).toBe('EUR')
      // Per user, like the rest.
      expect(loadExpenseLast('u2')).toBeNull()
    })

    it('is absent until one is used, and for what an older version stored', () => {
      saveExpenseLast('u1', { cardId: 'c1', category: 'coffee' })
      expect(loadExpenseLast('u1')).toEqual({ cardId: 'c1', category: 'coffee' })
      expect('currency' in (loadExpenseLast('u1') ?? {})).toBe(false)
    })

    it('reads something that is no code as none, keeping the card and category', () => {
      for (const currency of ['usd', 'US', 840, null, '']) {
        localStorage.setItem('bettracker:expense-last:u1', JSON.stringify({ cardId: 'c1', category: 'coffee', currency }))
        expect(loadExpenseLast('u1'), String(currency)).toEqual({ cardId: 'c1', category: 'coffee' })
      }
      saveExpenseLast('u1', { cardId: 'c1', category: 'coffee', currency: 'dollars' })
      expect(loadExpenseLast('u1')).toEqual({ cardId: 'c1', category: 'coffee' })
    })

    it('rememberPayCurrency (a scan in another currency) keeps the card and category last used', () => {
      rememberPayCurrency('u1', 'USD')
      expect(loadExpenseLast('u1')).toEqual({ cardId: null, category: 'other', currency: 'USD' })
      saveExpenseLast('u1', { cardId: 'c1', category: 'coffee' })
      rememberPayCurrency('u1', 'EUR')
      expect(loadExpenseLast('u1')).toEqual({ cardId: 'c1', category: 'coffee', currency: 'EUR' })
      rememberPayCurrency('u1', 'nope')
      expect(loadExpenseLast('u1')?.currency).toBe('EUR')
    })
  })

  it('goes with the rest on sign-out, and is not written back meanwhile', () => {
    saveExpenseLast('u2', { cardId: 'c1', category: 'coffee' })
    clearUserData('u2')
    expect(loadExpenseLast('u2')).toBeNull()
    saveExpenseLast('u2', { cardId: 'c1', category: 'coffee' })
    expect(localStorage.getItem('bettracker:expense-last:u2')).toBeNull()
  })
})
