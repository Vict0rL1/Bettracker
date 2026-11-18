import { describe, expect, it } from 'vitest'
import type { ExpenseCard } from '../../../shared/types'
import { matchCard, normalizeCardName } from './cardMatch'

const card = (id: string, name: string, last4 = '', archived = false): ExpenseCard => ({
  id,
  name,
  last4,
  kind: 'credit',
  archived,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z'
})

const VISA = card('v', 'Visa Oro', '1234')
const AMEX = card('a', 'Amex Platinum', '9876')
const DEBIT = card('d', 'Débito BBVA', '1234')
const OLD = card('o', 'Apple Card', '5555', true)

describe('normalizeCardName', () => {
  it('lowercase, no accents, only letters and digits', () => {
    expect(normalizeCardName('  Débito (BBVA) — 1234 ')).toBe('debito bbva 1234')
    expect(normalizeCardName('Visa•Oro')).toBe('visa oro')
  })
})

describe('matchCard', () => {
  it('by the last 4 digits when one card has them', () => {
    expect(matchCard({ last4: '9876', name: null }, [VISA, AMEX])).toEqual({ cardId: 'a', how: 'last4' })
    expect(matchCard({ last4: '9876', name: 'Visa' }, [VISA, AMEX])).toEqual({ cardId: 'a', how: 'last4' })
  })

  it('two cards with the same digits: the name picks one, or none', () => {
    expect(matchCard({ last4: '1234', name: 'BBVA debito' }, [VISA, DEBIT])).toEqual({ cardId: 'd', how: 'last4' })
    expect(matchCard({ last4: '1234', name: null }, [VISA, DEBIT])).toEqual({ cardId: null, how: 'none' })
    expect(matchCard({ last4: '1234', name: 'Mastercard' }, [VISA, DEBIT])).toEqual({ cardId: null, how: 'none' })
  })

  it('never an archived card', () => {
    expect(matchCard({ last4: '5555', name: 'Apple Card' }, [VISA, OLD])).toEqual({ cardId: null, how: 'none' })
    expect(matchCard({ last4: '1234', name: null }, [VISA, card('x', 'Twin', '1234', true)])).toEqual({ cardId: 'v', how: 'last4' })
  })

  it('by name: equal, one inside the other, or every word of the card’s name', () => {
    expect(matchCard({ last4: null, name: 'visa oro' }, [VISA, AMEX])).toEqual({ cardId: 'v', how: 'name' })
    expect(matchCard({ last4: null, name: 'Amex' }, [VISA, AMEX])).toEqual({ cardId: 'a', how: 'name' })
    expect(matchCard({ last4: null, name: 'Tarjeta Visa Oro BBVA' }, [VISA, AMEX])).toEqual({ cardId: 'v', how: 'name' })
    expect(matchCard({ last4: null, name: 'Platinum card from Amex' }, [VISA, AMEX])).toEqual({ cardId: 'a', how: 'name' })
  })

  it('ignores accents and case', () => {
    expect(matchCard({ last4: null, name: 'DEBITO bbva' }, [VISA, DEBIT])).toEqual({ cardId: 'd', how: 'name' })
  })

  it('digits that match no card fall back to the name', () => {
    expect(matchCard({ last4: '0000', name: 'Amex' }, [VISA, AMEX])).toEqual({ cardId: 'a', how: 'name' })
  })

  it('too short to tell, or several names that fit: none', () => {
    expect(matchCard({ last4: null, name: 'Vi' }, [VISA, AMEX])).toEqual({ cardId: null, how: 'none' })
    expect(matchCard({ last4: null, name: 'Visa' }, [VISA, card('w', 'Visa Clásica')])).toEqual({ cardId: null, how: 'none' })
  })

  it('nothing to go on, or no cards: none', () => {
    expect(matchCard({ last4: null, name: null }, [VISA])).toEqual({ cardId: null, how: 'none' })
    expect(matchCard({ last4: '123', name: '' }, [VISA])).toEqual({ cardId: null, how: 'none' })
    expect(matchCard({ last4: '1234', name: 'Visa' }, [])).toEqual({ cardId: null, how: 'none' })
  })
})
