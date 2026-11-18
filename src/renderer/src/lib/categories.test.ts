import { describe, expect, it } from 'vitest'
import { categoryKey, EXPENSE_CATEGORIES, isExpenseCategory, toCategory } from './categories'
import { en, es } from './strings'

describe('expense categories', () => {
  it('are the fixed list, in the order the app offers them', () => {
    expect(EXPENSE_CATEGORIES).toEqual(['coffee', 'food', 'groceries', 'transport', 'shopping', 'entertainment', 'health', 'home', 'subscriptions', 'travel', 'other'])
  })

  it('toCategory files anything the app does not know as other', () => {
    expect(toCategory('coffee')).toBe('coffee')
    expect(toCategory('travel')).toBe('travel')
    for (const v of ['Coffee', 'fuel', '', null, undefined, 3, {}]) expect(toCategory(v), String(v)).toBe('other')
  })

  it('isExpenseCategory knows exactly the stored keys', () => {
    for (const c of EXPENSE_CATEGORIES) expect(isExpenseCategory(c)).toBe(true)
    expect(isExpenseCategory('COFFEE')).toBe(false)
    expect(isExpenseCategory('toString')).toBe(false)
  })

  it('has a label for each in both languages', () => {
    for (const c of EXPENSE_CATEGORIES) {
      const key = categoryKey(c)
      expect(key).toBe(`cat.${c}`)
      expect(en[key as keyof typeof en], key).toBeTruthy()
      expect(es[key], key).toBeTruthy()
    }
    expect(en['cat.coffee']).toBe('Coffee')
    expect(es['cat.coffee']).toBe('Café')
    expect(es['cat.home']).toBe('Casa y servicios')
  })
})
