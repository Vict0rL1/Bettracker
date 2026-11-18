import { describe, expect, it } from 'vitest'
import { budgetId, stableUuid } from './stableId'

// The same as backup.ts's UUID check (and Postgres takes it as a uuid).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const USER = '11111111-2222-3333-4444-555555555555'
const CARD = '6f9619ff-8b86-d011-b42d-00cf4fc964ff'

describe('stableUuid', () => {
  it('is the same id for the same text, every time', () => {
    expect(stableUuid('a budget')).toBe(stableUuid('a budget'))
    expect(stableUuid('a budget')).not.toBe(stableUuid('a budget '))
  })

  it('is a lowercase UUID with version nibble 8 and the RFC 4122 variant', () => {
    for (const text of ['', 'abc', 'expense-budget|x|total|', 'ñandú ☕ 😀', 'x'.repeat(5000)]) {
      const id = stableUuid(text)
      expect(id, text).toMatch(UUID)
      expect(id).toBe(id.toLowerCase())
      expect(id[14], text).toBe('8')
      expect('89ab', text).toContain(id[19])
    }
  })

  // Frozen: budgets set on one device must keep meeting the ones set on another.
  it('never changes (pinned values)', () => {
    expect(stableUuid('abc')).toBe('4664cddf-317f-8918-ac48-7c9f600d8b09')
    expect(budgetId(USER, 'total', '')).toBe('e1d25478-9f91-8332-95ee-d819013cc60f')
    expect(budgetId(USER, 'category', 'coffee')).toBe('7a1a7b6a-3781-8788-bd5a-26532a25e252')
  })
})

describe('budgetId', () => {
  it('differs by user, scope and target', () => {
    const ids = [
      budgetId(USER, 'total', ''),
      budgetId('99999999-2222-3333-4444-555555555555', 'total', ''),
      budgetId(USER, 'card', CARD),
      budgetId(USER, 'category', 'coffee'),
      budgetId(USER, 'category', 'food')
    ]
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(UUID)
  })

  it('reads the user id and a card id whatever their case', () => {
    expect(budgetId(USER.toUpperCase(), 'total', '')).toBe(budgetId(USER, 'total', ''))
    expect(budgetId(USER, 'card', CARD.toUpperCase())).toBe(budgetId(USER, 'card', CARD))
  })
})
