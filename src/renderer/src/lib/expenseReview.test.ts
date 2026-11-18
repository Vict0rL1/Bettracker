import { describe, expect, it } from 'vitest'
import type { ExtractedExpense, ExtractResult } from '../../../shared/expenseExtraction'
import type { Expense, ExpenseCard } from '../../../shared/types'
import {
  applyCardToUnmatched,
  buildReview,
  findDuplicate,
  normalizeMerchant,
  reviewInputs,
  reviewRowProblem,
  setAllIncluded,
  similarMerchant,
  type ReviewRow
} from './expenseReview'

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const card = (id: string, name: string, last4: string, archived = false): ExpenseCard => ({ id, name, last4, kind: 'credit', archived, createdAt: '2026-01-01', updatedAt: '2026-01-01' })
const CARDS = [card(A, 'Visa Oro', '1234'), card(B, 'Amex', '9876'), card('cccccccc-0000-4000-8000-000000000003', 'Old', '5555', true)]
const TODAY = '2026-11-17'

const saved = (over: Partial<Expense> & { id: string }): Expense => ({
  date: TODAY,
  amount: 23.18,
  cardId: A,
  merchant: 'Supermercado La Plaza',
  category: 'groceries',
  note: '',
  source: 'manual',
  createdAt: '2026-11-17T10:00:00Z',
  updatedAt: '2026-11-17T10:00:00Z',
  ...over
})
const read = (over: Partial<ExtractedExpense> = {}): ExtractedExpense => ({
  date: TODAY,
  amount: 4.5,
  merchant: 'Café Central',
  category: 'coffee',
  cardLast4: null,
  cardHint: null,
  note: '',
  pending: false,
  confidence: 'high',
  ...over
})
const result = (expenses: ExtractedExpense[]): ExtractResult => ({ kind: 'wallet', currency: 'USD', expenses, warnings: [] })

describe('normalizeMerchant and similarMerchant', () => {
  it('drop the noise card terminals add', () => {
    expect(normalizeMerchant('SQ *Blue Bottle Coffee #1234')).toBe('blue bottle coffee')
    expect(normalizeMerchant('TST* Taquería El Güero')).toBe('taqueria el guero')
    expect(normalizeMerchant('PP*NETFLIX.COM')).toBe('netflix com')
    expect(normalizeMerchant('Grupo Bimbo S.A. de C.V.')).toBe('grupo bimbo')
    expect(normalizeMerchant('Casa de Campo')).toBe('casa de campo')
    expect(normalizeMerchant('Acme, Inc.')).toBe('acme')
    expect(normalizeMerchant('Zara España SA')).toBe('zara espana')
    expect(normalizeMerchant('SA')).toBe('sa')
  })

  it('similar: either empty, equal, or one starts with the other (≥ 4 chars)', () => {
    expect(similarMerchant('SUPERMERCADO LA PLAZA #123', 'Supermercado La Plaza')).toBe(true)
    expect(similarMerchant('Starbucks', 'STARBUCKS COFFEE 0042')).toBe(true)
    expect(similarMerchant('', 'Uber')).toBe(true)
    expect(similarMerchant('Uber', 'Uber Eats')).toBe(true)
    expect(similarMerchant('Bar', 'Barcelona Store')).toBe(false)
    expect(similarMerchant('Uber', 'Lyft')).toBe(false)
  })
})

describe('findDuplicate', () => {
  const older = saved({ id: 'old', createdAt: '2026-11-17T09:00:00Z' })
  const newer = saved({ id: 'new', createdAt: '2026-11-17T11:00:00Z' })
  const c = { date: TODAY, amount: 23.18, cardId: A, merchant: 'SUPERMERCADO LA PLAZA #123' }

  it('same date, same cents, a compatible card and a similar merchant; the oldest first', () => {
    expect(findDuplicate(c, [newer, older], new Set())?.id).toBe('old')
    expect(findDuplicate({ ...c, cardId: null }, [newer], new Set())?.id).toBe('new')
    expect(findDuplicate(c, [saved({ id: 'x', cardId: null })], new Set())?.id).toBe('x')
  })

  it('a different cent, date, card, sign or merchant is no duplicate', () => {
    expect(findDuplicate({ ...c, amount: 23.17 }, [older], new Set())).toBeNull()
    expect(findDuplicate({ ...c, amount: -23.18 }, [older], new Set())).toBeNull()
    expect(findDuplicate({ ...c, date: '2026-11-16' }, [older], new Set())).toBeNull()
    expect(findDuplicate({ ...c, cardId: B }, [older], new Set())).toBeNull()
    expect(findDuplicate({ ...c, merchant: 'Walmart' }, [older], new Set())).toBeNull()
  })

  it('never matches one saved expense twice', () => {
    const taken = new Set<string>()
    expect(findDuplicate(c, [older], taken)?.id).toBe('old')
    expect(findDuplicate(c, [older], taken)).toBeNull()
    expect([...taken]).toEqual(['old'])
  })
})

describe('buildReview', () => {
  const existing = [saved({ id: 'dup' })]

  it('one row per expense read: matched card, unticked duplicate, refund as an unsigned amount', () => {
    const rows = buildReview(
      result([
        read({ cardLast4: '1234' }),
        read({ amount: 23.18, merchant: 'SUPERMERCADO LA PLAZA #123', category: 'groceries', cardLast4: '1234', confidence: 'medium' }),
        read({ amount: -12, merchant: 'Zara', category: 'shopping' })
      ]),
      { today: TODAY, cards: CARDS, existing, currency: 'USD' }
    )
    expect(rows.map((r) => r.key)).toEqual(['r0', 'r1', 'r2'])
    expect(rows[0]).toEqual({
      key: 'r0',
      include: true,
      open: false,
      date: TODAY,
      dateGuessed: false,
      amount: '4.50',
      refund: false,
      merchant: 'Café Central',
      category: 'coffee',
      cardId: A,
      cardHow: 'last4',
      cardUnknownLast4: null,
      note: '',
      pending: false,
      confidence: 'high',
      duplicateOf: null
    })
    expect(rows[1]).toMatchObject({ include: false, duplicateOf: existing[0], cardId: A })
    expect(rows[2]).toMatchObject({ include: true, amount: '12.00', refund: true, cardId: null, cardHow: 'none' })
  })

  it('a card found by its name', () => {
    const [row] = buildReview(result([read({ cardHint: 'AMEX' })]), { today: TODAY, cards: CARDS, existing: [], currency: 'USD' })
    expect(row).toMatchObject({ cardId: B, cardHow: 'name' })
  })

  it('digits that are none of the active cards: no card, and the review says which digits', () => {
    const [row] = buildReview(result([read({ cardLast4: '4321', cardHint: 'Visa Oro' })]), { today: TODAY, cards: CARDS, existing: [], currency: 'USD' })
    expect(row).toMatchObject({ cardId: null, cardHow: 'none', cardUnknownLast4: '4321' })
    const [archived] = buildReview(result([read({ cardLast4: '5555' })]), { today: TODAY, cards: CARDS, existing: [], currency: 'USD' })
    expect(archived).toMatchObject({ cardId: null, cardUnknownLast4: '5555' })
  })

  it('a card saved without its last 4 is still found by its name when the image shows digits', () => {
    const apple = card('dddddddd-0000-4000-8000-000000000004', 'Apple Card', '')
    const cards = [...CARDS, apple]
    const [row] = buildReview(result([read({ cardLast4: '4321', cardHint: 'Apple Card' })]), { today: TODAY, cards, existing: [], currency: 'USD' })
    expect(row).toMatchObject({ cardId: apple.id, cardHow: 'name', cardUnknownLast4: null })
    // A card with other digits on record is still ruled out by them.
    const [visa] = buildReview(result([read({ cardLast4: '4321', cardHint: 'Visa Oro' })]), { today: TODAY, cards, existing: [], currency: 'USD' })
    expect(visa).toMatchObject({ cardId: null, cardHow: 'none', cardUnknownLast4: '4321' })
    // No name to go by: no card, and the review says which digits.
    const [unnamed] = buildReview(result([read({ cardLast4: '4321' })]), { today: TODAY, cards, existing: [], currency: 'USD' })
    expect(unnamed).toMatchObject({ cardId: null, cardHow: 'none', cardUnknownLast4: '4321' })
  })

  it('no date read: today, guessed, and the row opens; so does a low-confidence one', () => {
    const rows = buildReview(result([read({ date: null, confidence: 'low' }), read({ confidence: 'low' })]), { today: TODAY, cards: CARDS, existing: [], currency: 'USD' })
    expect(rows[0]).toMatchObject({ date: TODAY, dateGuessed: true, open: true })
    expect(rows[1]).toMatchObject({ dateGuessed: false, open: true })
  })

  it('opens a row whose amount the currency can’t hold', () => {
    const [row] = buildReview(result([read({ amount: 4.5 })]), { today: TODAY, cards: CARDS, existing: [], currency: 'CLP' })
    expect(row).toMatchObject({ amount: '4.50', open: true })
  })

  it('keeps pending rows, ticked', () => {
    const [row] = buildReview(result([read({ pending: true })]), { today: TODAY, cards: CARDS, existing: [], currency: 'USD' })
    expect(row).toMatchObject({ pending: true, include: true })
  })
})

describe('the review’s edits', () => {
  const rows = buildReview(
    result([read({ cardLast4: '1234' }), read({ merchant: 'Uber', amount: 9 }), read({ merchant: 'Zara', amount: -12 })]),
    { today: TODAY, cards: CARDS, existing: [], currency: 'USD' }
  )

  it('applyCardToUnmatched: only rows still without a card, again and again', () => {
    const once = applyCardToUnmatched(rows, B)
    expect(once.map((r) => r.cardId)).toEqual([A, B, B])
    expect(applyCardToUnmatched(once, null).map((r) => r.cardId)).toEqual([A, null, null])
    const picked: ReviewRow[] = once.map((r, i) => (i === 1 ? { ...r, cardId: A, cardHow: 'user' } : r))
    expect(applyCardToUnmatched(picked, null).map((r) => r.cardId)).toEqual([A, A, null])
  })

  it('setAllIncluded ticks or unticks every row', () => {
    expect(setAllIncluded(rows, false).map((r) => r.include)).toEqual([false, false, false])
    expect(setAllIncluded(setAllIncluded(rows, false), true).map((r) => r.include)).toEqual([true, true, true])
  })

  it('reviewRowProblem: the amount in the currency’s digits, then the date', () => {
    expect(reviewRowProblem(rows[0], 'USD')).toBeNull()
    expect(reviewRowProblem({ ...rows[0], amount: '4,5' }, 'CLP')).toEqual({ key: 'field.noMinorUnits', vars: { currency: 'CLP' } })
    expect(reviewRowProblem({ ...rows[0], amount: '' }, 'USD')).toEqual({ key: 'field.resultRequired' })
    expect(reviewRowProblem({ ...rows[0], date: '2026-13-01' }, 'USD')).toEqual({ key: 'field.dateInvalid' })
  })

  it('reviewInputs: the ticked rows, signed by their toggle, from the AI', () => {
    const edited = [{ ...rows[0], amount: '4,50' }, { ...rows[1], include: false }, rows[2]]
    expect(reviewInputs(edited, 'EUR')).toEqual([
      { date: TODAY, amount: 4.5, cardId: A, merchant: 'Café Central', category: 'coffee', note: '', source: 'ai' },
      { date: TODAY, amount: -12, cardId: null, merchant: 'Zara', category: 'coffee', note: '', source: 'ai' }
    ])
  })
})
