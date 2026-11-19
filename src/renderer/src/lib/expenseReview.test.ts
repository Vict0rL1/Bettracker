import { describe, expect, it } from 'vitest'
import type { ExtractedExpense, ExtractResult } from '../../../shared/expenseExtraction'
import type { Expense, ExpenseCard } from '../../../shared/types'
import { rateKey, type FxAuto } from './expenseFx'
import {
  applyCardToUnmatched,
  buildReview,
  chargedOf,
  commonCurrency,
  findDuplicate,
  merchantMemory,
  normalizeMerchant,
  pictureCurrency,
  refreshDuplicates,
  rememberedCurrency,
  reviewAdds,
  reviewInputs,
  reviewRowProblem,
  rowAsCharged,
  rowCurrency,
  rowLacksRate,
  rowMoney,
  rowReady,
  sameMoney,
  setAllCurrencies,
  setAllIncluded,
  setRowCurrency,
  similarMerchant,
  wantedRates,
  type ReviewMoney,
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
  originalAmount: null,
  originalCurrency: null,
  fxRate: null,
  cardId: A,
  merchant: 'Supermercado La Plaza',
  category: 'groceries',
  note: '',
  source: 'manual',
  createdAt: '2026-11-17T10:00:00Z',
  updatedAt: '2026-11-17T10:00:00Z',
  ...over
})
/** A row read; its currency not shown unless said (so it takes the picture's, as `result` names one). */
const read = (over: Partial<ExtractedExpense> = {}): ExtractedExpense => ({
  date: TODAY,
  amount: 4.5,
  currency: null,
  currencyBasis: 'none',
  chargedAmount: null,
  chargedCurrency: null,
  merchant: 'Café Central',
  category: 'coffee',
  cardLast4: null,
  cardHint: null,
  note: '',
  pending: false,
  confidence: 'high',
  ...over
})
const result = (expenses: ExtractedExpense[], currency: string | null = 'USD'): ExtractResult => ({ kind: 'wallet', currency, expenses, warnings: [] })

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
      currency: 'USD',
      currencyHow: 'picture',
      currencyAssumed: false,
      charged: null,
      fx: null,
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
    // A picture that names no currency is read in the main one: Chilean pesos have no cents.
    const [row] = buildReview(result([read({ amount: 4.5 })], null), { today: TODAY, cards: CARDS, existing: [], currency: 'CLP' })
    expect(row).toMatchObject({ amount: '4.50', open: true })
    const [clp] = buildReview(result([read({ amount: 4.5 })], 'CLP'), { today: TODAY, cards: CARDS, existing: [], currency: 'CLP' })
    expect(clp).toMatchObject({ amount: '4.50', open: true })
    // A picture in dollars is in dollars (it is converted, not squeezed into pesos): 4.50 is fine there.
    const [usd] = buildReview(result([read({ amount: 4.5 })], 'USD'), { today: TODAY, cards: CARDS, existing: [], currency: 'CLP' })
    expect(usd).toMatchObject({ amount: '4.50', open: false })
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
    expect(reviewRowProblem({ ...rows[0], currency: 'CLP', amount: '4,5' }, 'CLP')).toEqual({ key: 'field.noMinorUnits', vars: { currency: 'CLP' } })
    // The row's own currency, whatever the main one: pesos in a review in dollars too.
    expect(reviewRowProblem({ ...rows[0], currency: 'CLP', amount: '4,5' }, 'USD')).toEqual({ key: 'field.noMinorUnits', vars: { currency: 'CLP' } })
    expect(reviewRowProblem({ ...rows[0], amount: '' }, 'USD')).toEqual({ key: 'field.resultRequired' })
    expect(reviewRowProblem({ ...rows[0], date: '2026-13-01' }, 'USD')).toEqual({ key: 'field.dateInvalid' })
  })

  it('reviewInputs: the ticked rows, signed by their toggle, from the AI', () => {
    const edited = [{ ...rows[0], amount: '4,50' }, { ...rows[1], include: false }, rows[2]]
    // In the main currency (the rows' own) nothing of an original goes with them.
    const none = { originalAmount: null, originalCurrency: null, fxRate: null }
    expect(reviewInputs(edited, 'USD')).toEqual([
      { date: TODAY, amount: 4.5, ...none, cardId: A, merchant: 'Café Central', category: 'coffee', note: '', source: 'ai' },
      { date: TODAY, amount: -12, ...none, cardId: null, merchant: 'Zara', category: 'coffee', note: '', source: 'ai' }
    ])
  })
})

describe('a picture in another currency', () => {
  const D13 = '2026-11-13'
  const D14 = '2026-11-14'
  const ecb = (rate: number, asOf: string): FxAuto => ({ rate, asOf, source: 'service' })
  /** A review in CAD with rates of one currency (USD unless said) by date, and the rate typed for that currency's rows. */
  const money = (over: { currency?: string; rates?: Record<string, FxAuto>; all?: number | null } = {}): ReviewMoney => {
    const cur = over.currency ?? 'USD'
    return {
      main: 'CAD',
      rates: Object.fromEntries(Object.entries(over.rates ?? {}).map(([date, rate]) => [rateKey(cur, date), rate])),
      all: over.all === undefined || over.all === null ? {} : { [cur]: over.all }
    }
  }
  const build = (expenses: ExtractedExpense[], existing: Expense[] = [], currency: string | null = 'USD') => buildReview(result(expenses, currency), { today: TODAY, cards: CARDS, existing, currency: 'CAD' })

  it('pictureCurrency: what the reading names, else the main currency', () => {
    expect(pictureCurrency({ currency: 'USD' }, 'CAD')).toBe('USD')
    expect(pictureCurrency({ currency: null }, 'CAD')).toBe('CAD')
    expect(pictureCurrency({ currency: 'CAD' }, 'CAD')).toBe('CAD')
    // The reading is checked on its way in, but a code that is none never becomes the currency.
    expect(pictureCurrency({ currency: 'dollars' }, 'CAD')).toBe('CAD')
  })

  it('writes what was read in the picture’s own currency: pesos without cents, dollars with', () => {
    expect(build([read({ amount: 12500 })], [], 'COP')[0].amount).toBe('12500')
    expect(build([read({ amount: 12 })])[0].amount).toBe('12.00')
  })

  describe('rowMoney — what a row comes to', () => {
    const [row] = build([read({ amount: 12, date: D13 })])

    it('in the main currency it is what was read, signed', () => {
      const cad = { ...row, currency: 'CAD' }
      expect(rowMoney(cad, sameMoney('CAD'))).toEqual({ foreign: false, paid: 12, view: null, amount: 12 })
      expect(rowMoney({ ...cad, refund: true }, sameMoney('CAD')).amount).toBe(-12)
      expect(rowMoney({ ...cad, amount: 'x' }, sameMoney('CAD'))).toMatchObject({ paid: null, amount: null })
    })

    it('with its day’s rate: the original stays, the amount is converted', () => {
      const m = money({ rates: { [D13]: ecb(1.4034, D13) } })
      const got = rowMoney(row, m)
      expect(got).toMatchObject({ foreign: true, paid: 12, amount: 16.84 })
      expect(got.view).toMatchObject({ rate: 1.4034, converted: 16.84, origin: { how: 'service', asOf: D13 } })
      expect(rowMoney({ ...row, refund: true }, m).amount).toBe(-16.84)
    })

    it('without a rate the amount is not known', () => {
      expect(rowMoney(row, money())).toMatchObject({ foreign: true, paid: 12, amount: null })
      // Another day's rate is not this day's.
      expect(rowMoney(row, money({ rates: { [D14]: ecb(1.41, D14) } })).amount).toBeNull()
    })

    it('the rate typed for every row without one fills in, and a fetched one wins over it', () => {
      expect(rowMoney(row, money({ all: 1.4 }))).toMatchObject({ amount: 16.8 })
      expect(rowMoney(row, money({ all: 1.4 })).view?.origin).toEqual({ how: 'typedAll' })
      expect(rowMoney(row, money({ all: 1.4, rates: { [D13]: ecb(1.4034, D13) } })).amount).toBe(16.84)
    })

    it('what the person typed on the row wins over both: a rate, or the amount the bank charged', () => {
      const m = money({ all: 1.4, rates: { [D13]: ecb(1.4034, D13) } })
      expect(rowMoney({ ...row, fx: { lead: 'rate', text: '1.5' } }, m)).toMatchObject({ amount: 18 })
      const bank = rowMoney({ ...row, fx: { lead: 'converted', text: '17.25' } }, m)
      expect(bank).toMatchObject({ amount: 17.25 })
      expect(bank.view).toMatchObject({ rate: 1.4375, origin: { how: 'typed' } })
    })
  })

  describe('which rows can be added', () => {
    const rows = build([read({ amount: 12, date: D13 }), read({ amount: 5, date: D14, merchant: 'Uber' }), read({ amount: -3, date: D14, merchant: 'Zara' })])
    const m = money({ rates: { [D13]: ecb(1.4034, D13) } })

    it('a row with a rate is ready; one without is not, and says it lacks one (it is not a problem to fix on the row)', () => {
      expect(rows.map((r) => rowReady(r, m))).toEqual([true, false, false])
      expect(rows.map((r) => rowLacksRate(r, m))).toEqual([false, true, true])
      expect(rows.map((r) => reviewRowProblem(r, m))).toEqual([null, null, null])
      expect(setAllCurrencies(rows, 'CAD', 'CAD').every((r) => !rowLacksRate(r, sameMoney('CAD')))).toBe(true)
    })

    it('"Add N" takes only the ticked rows that have a rate, and says which', () => {
      const { inputs, keys } = reviewAdds(rows, m)
      expect(keys).toEqual(['r0'])
      expect(inputs).toEqual([
        { date: D13, amount: 16.84, originalAmount: 12, originalCurrency: 'USD', fxRate: 1.4034, cardId: null, merchant: 'Café Central', category: 'coffee', note: '', source: 'ai' }
      ])
    })

    it('one rate for all fills the rest; a refund is negative in both amounts', () => {
      const { inputs, keys } = reviewAdds(rows, { ...m, all: { USD: 1.4 } })
      expect(keys).toEqual(['r0', 'r1', 'r2'])
      expect(inputs.map((i) => [i.amount, i.originalAmount, i.originalCurrency, i.fxRate])).toEqual([
        [16.84, 12, 'USD', 1.4034],
        [7, 5, 'USD', 1.4],
        [-4.2, -3, 'USD', 1.4]
      ])
    })

    it('an unticked row is never added, with or without a rate', () => {
      expect(reviewAdds(setAllIncluded(rows, false), { ...m, all: { USD: 1.4 } })).toEqual({ inputs: [], keys: [] })
    })

    it('a rate typed on a row that can’t be read is a problem of that row, and it is not added', () => {
      const bad: ReviewRow = { ...rows[0], fx: { lead: 'rate', text: 'abc' } }
      expect(reviewRowProblem(bad, m)).toEqual({ key: 'field.rateInvalid' })
      expect(rowReady(bad, m)).toBe(false)
      expect(rowLacksRate(bad, m)).toBe(false)
      const zero: ReviewRow = { ...rows[0], fx: { lead: 'converted', text: '0' } }
      expect(reviewRowProblem(zero, m)).toEqual({ key: 'field.convertedRequired', vars: { currency: 'CAD' } })
      // Emptied and not left yet: nothing to fix, it falls back to the day's rate.
      expect(reviewRowProblem({ ...rows[0], fx: { lead: 'rate', text: '' } }, m)).toBeNull()
    })

    it('the amount box is read with the digits of the row’s currency', () => {
      const cop = money({ currency: 'COP', all: 0.00034 })
      expect(rowMoney({ ...rows[0], currency: 'COP', amount: '12.500' }, cop)).toMatchObject({ paid: 12500, amount: 4.25 })
      expect(reviewRowProblem({ ...rows[0], currency: 'COP', amount: '12.50' }, cop)).toEqual({ key: 'field.noMinorUnits', vars: { currency: 'COP' } })
    })

    it('every input passes the app’s checks', async () => {
      const { normalizeExpense } = await import('./validate')
      for (const input of reviewAdds(rows, { ...m, all: { USD: 1.4 } }).inputs) expect(() => normalizeExpense(input)).not.toThrow()
    })
  })

  describe('duplicates', () => {
    const paidUsd = saved({ id: 'usd', date: D13, amount: 16.8, originalAmount: 12, originalCurrency: 'USD', fxRate: 1.4, merchant: 'Apple.com', cardId: null })
    const c = { date: D13, amount: null, original: { amount: 12, currency: 'USD' }, cardId: null, merchant: 'APPLE.COM/BILL' }

    it('the same amount paid in the same currency is the same purchase, whatever rate each got', () => {
      expect(findDuplicate(c, [paidUsd], new Set())?.id).toBe('usd')
      expect(findDuplicate({ ...c, amount: 16.84 }, [paidUsd], new Set())?.id).toBe('usd')
    })

    it('not the same number in another currency, another cent or another sign', () => {
      expect(findDuplicate({ ...c, original: { amount: 12, currency: 'EUR' } }, [paidUsd], new Set())).toBeNull()
      expect(findDuplicate({ ...c, original: { amount: 12.01, currency: 'USD' } }, [paidUsd], new Set())).toBeNull()
      expect(findDuplicate({ ...c, original: { amount: -12, currency: 'USD' } }, [paidUsd], new Set())).toBeNull()
      // Twelve dollars is not a saved expense of twelve in the main currency.
      expect(findDuplicate(c, [saved({ id: 'cad', date: D13, amount: 12, merchant: 'Apple.com', cardId: null })], new Set())).toBeNull()
    })

    it('or the same amount in the main currency, once the rate says what that is', () => {
      const typedByHand = saved({ id: 'cad', date: D13, amount: 16.84, merchant: 'Apple.com', cardId: null })
      expect(findDuplicate(c, [typedByHand], new Set())).toBeNull()
      expect(findDuplicate({ ...c, amount: 16.84 }, [typedByHand], new Set())?.id).toBe('cad')
    })

    it('the date, the card and the merchant still have to agree', () => {
      expect(findDuplicate({ ...c, date: D14 }, [paidUsd], new Set())).toBeNull()
      expect(findDuplicate({ ...c, merchant: 'Netflix' }, [paidUsd], new Set())).toBeNull()
      expect(findDuplicate({ ...c, cardId: A }, [{ ...paidUsd, cardId: B }], new Set())).toBeNull()
    })

    it('a reading is matched by what was paid from the start, before any rate is known', () => {
      const [row, other] = build([read({ amount: 12, date: D13, merchant: 'APPLE.COM/BILL' }), read({ amount: 9, date: D13, merchant: 'Uber' })], [paidUsd])
      expect(row).toMatchObject({ include: false, duplicateOf: paidUsd })
      expect(other).toMatchObject({ include: true, duplicateOf: null })
    })

    describe('refreshDuplicates — the matches follow the rates and the saved expenses', () => {
      const typedByHand = saved({ id: 'cad', date: D13, amount: 16.84, merchant: 'Apple.com', cardId: null })
      const rows = build([read({ amount: 12, date: D13, merchant: 'APPLE.COM/BILL' }), read({ amount: 9, date: D13, merchant: 'Uber' })], [typedByHand])

      it('is the same array while nothing changes', () => {
        expect(rows.map((r) => r.duplicateOf)).toEqual([null, null])
        expect(refreshDuplicates(rows, [typedByHand], money())).toBe(rows)
        expect(refreshDuplicates([], [typedByHand], money())).toEqual([])
      })

      it('a rate arrives: the row now comes to an amount already saved, and is unticked next to it', () => {
        const next = refreshDuplicates(rows, [typedByHand], money({ rates: { [D13]: ecb(1.4034, D13) } }))
        expect(next).not.toBe(rows)
        expect(next[0]).toMatchObject({ include: false, duplicateOf: typedByHand })
        // The other row is the very object it was: what the person chose on it stands.
        expect(next[1]).toBe(rows[1])
      })

      it('the saved expense goes away: the row is ticked again', () => {
        const m = money({ rates: { [D13]: ecb(1.4034, D13) } })
        const matched = refreshDuplicates(rows, [typedByHand], m)
        expect(refreshDuplicates(matched, [], m)[0]).toMatchObject({ include: true, duplicateOf: null })
      })

      it('a tick the person put back on a duplicate is kept while its match stays the same', () => {
        const m = money({ rates: { [D13]: ecb(1.4034, D13) } })
        const matched = refreshDuplicates(rows, [typedByHand], m).map((r, i) => (i === 0 ? { ...r, include: true } : r))
        expect(refreshDuplicates(matched, [typedByHand], m)).toBe(matched)
      })

      it('every row’s currency changes: the same number in the main currency is another amount', () => {
        const twelve = saved({ id: 'twelve', date: D13, amount: 12, merchant: 'Apple.com', cardId: null })
        // Read as dollars: no match with 12.00 in the main currency.
        expect(refreshDuplicates(rows, [twelve], money())[0].duplicateOf).toBeNull()
        // The person says the picture is in the main currency after all: now it is the same money.
        expect(refreshDuplicates(setAllCurrencies(rows, 'CAD', 'CAD'), [twelve], sameMoney('CAD'))[0]).toMatchObject({ include: false, duplicateOf: twelve })
      })

      it('a row whose amount can’t be read matches nothing', () => {
        const broken = rows.map((r) => ({ ...r, amount: 'x' }))
        expect(refreshDuplicates(broken, [typedByHand], money({ all: 1.4 })).map((r) => r.duplicateOf)).toEqual([null, null])
      })
    })
  })
})

describe('each row in its own currency', () => {
  const D13 = '2026-11-13'
  const ecb = (rate: number, asOf: string): FxAuto => ({ rate, asOf, source: 'service' })
  const shown = (currency: string, basis: 'code' | 'place' = 'code'): Partial<ExtractedExpense> => ({ currency, currencyBasis: basis })
  const build = (expenses: ExtractedExpense[], existing: Expense[] = [], currency: string | null = null) => buildReview(result(expenses, currency), { today: TODAY, cards: CARDS, existing, currency: 'CAD' })
  const inUsd = (over: Partial<Expense> & { id: string }) => saved({ originalAmount: 12, originalCurrency: 'USD', fxRate: 1.4, amount: 16.8, ...over })

  describe('merchantMemory and rememberedCurrency — what a merchant was last paid in', () => {
    it('the latest expense of the merchant, by date and then by when it was added, whatever its name looked like', () => {
      const memory = merchantMemory(
        [
          inUsd({ id: 'a', date: '2026-11-01', merchant: 'Blue Bottle Coffee' }),
          saved({ id: 'b', date: '2026-10-01', merchant: 'SQ *BLUE BOTTLE COFFEE #12' }),
          saved({ id: 'c', date: '2026-11-05', merchant: 'Tim Hortons', createdAt: '2026-11-05T09:00:00Z' }),
          inUsd({ id: 'd', date: '2026-11-05', merchant: 'tim hortons', createdAt: '2026-11-05T10:00:00Z' })
        ],
        'CAD'
      )
      expect(rememberedCurrency(memory, 'BLUE BOTTLE COFFEE #7')).toBe('USD')
      expect(rememberedCurrency(memory, 'Tim Hortons')).toBe('USD')
    })

    it('an expense in the main currency remembers the main currency', () => {
      const memory = merchantMemory([inUsd({ id: 'a', date: '2026-11-01', merchant: 'Amazon' }), saved({ id: 'b', date: '2026-11-02', merchant: 'AMAZON' })], 'CAD')
      expect(rememberedCurrency(memory, 'Amazon')).toBe('CAD')
    })

    it('nothing for a merchant never saved, a merchant name that is only noise, or no merchant', () => {
      const memory = merchantMemory([inUsd({ id: 'a', merchant: 'Blue Bottle Coffee' }), inUsd({ id: 'b', merchant: '' }), inUsd({ id: 'c', merchant: '#12' })], 'CAD')
      expect(rememberedCurrency(memory, 'Blue Bottle')).toBeNull()
      expect(rememberedCurrency(memory, '')).toBeNull()
      expect(rememberedCurrency(memory, '#12')).toBeNull()
      expect(memory.size).toBe(1)
    })
  })

  describe('rowCurrency — the currency a row starts in', () => {
    const o = { remembered: 'USD', picture: 'EUR', main: 'CAD' }

    it('what the image shows for it first, by its mark or by the place', () => {
      expect(rowCurrency({ currency: 'GBP', currencyBasis: 'code' }, o)).toEqual({ currency: 'GBP', how: 'read' })
      expect(rowCurrency({ currency: 'GBP', currencyBasis: 'place' }, o)).toEqual({ currency: 'GBP', how: 'read' })
    })

    it('then the merchant’s, then the picture’s one currency, then the main one', () => {
      const none = { currency: null, currencyBasis: 'none' as const }
      expect(rowCurrency(none, o)).toEqual({ currency: 'USD', how: 'memory' })
      expect(rowCurrency(none, { ...o, remembered: null })).toEqual({ currency: 'EUR', how: 'picture' })
      expect(rowCurrency(none, { ...o, remembered: null, picture: null })).toEqual({ currency: 'CAD', how: 'main' })
    })

    it('a code without a basis, or something that is no code, is not read', () => {
      expect(rowCurrency({ currency: 'GBP', currencyBasis: 'none' }, o)).toEqual({ currency: 'USD', how: 'memory' })
      expect(rowCurrency({ currency: 'dollars', currencyBasis: 'code' }, { ...o, remembered: 'x', picture: null })).toEqual({ currency: 'CAD', how: 'main' })
    })
  })

  describe('buildReview', () => {
    it('a Wallet list in CAD and USD: each row in its own, converted only where it isn’t the main one', () => {
      const rows = build([read({ amount: 12, ...shown('USD') }), read({ amount: 5.25, merchant: 'Tim Hortons', ...shown('CAD') }), read({ amount: 30, merchant: 'Target', ...shown('USD', 'place') })])
      expect(rows.map((r) => [r.currency, r.currencyHow, r.amount])).toEqual([
        ['USD', 'read', '12.00'],
        ['CAD', 'read', '5.25'],
        ['USD', 'read', '30.00']
      ])
      expect(rows.some((r) => r.currencyAssumed)).toBe(false)
      expect(commonCurrency(rows)).toBeNull()
      const m: ReviewMoney = { main: 'CAD', rates: { [rateKey('USD', TODAY)]: ecb(1.4, TODAY) }, all: {} }
      expect(rows.map((r) => rowMoney(r, m).amount)).toEqual([16.8, 5.25, 42])
      expect(reviewAdds(rows, m).inputs.map((i) => [i.amount, i.originalAmount, i.originalCurrency])).toEqual([
        [16.8, 12, 'USD'],
        [5.25, null, null],
        [42, 30, 'USD']
      ])
    })

    it('a bare "$" takes the currency the merchant was last paid in', () => {
      const [row, other] = build([read({ amount: 6.5, merchant: 'BLUE BOTTLE COFFEE #3' }), read({ merchant: 'Corner Store' })], [inUsd({ id: 'bb', date: '2026-11-01', merchant: 'Blue Bottle Coffee' })])
      expect(row).toMatchObject({ currency: 'USD', currencyHow: 'memory', currencyAssumed: false })
      // No memory: the main one, said to be assumed (this person pays in USD too).
      expect(other).toMatchObject({ currency: 'CAD', currencyHow: 'main', currencyAssumed: true })
    })

    it('"Currency assumed" only where it matters', () => {
      const bare = [read(), read({ merchant: 'Uber' })]
      // All in the main currency, for someone who never pays in another: nothing to say.
      expect(build(bare).map((r) => [r.currency, r.currencyAssumed])).toEqual([
        ['CAD', false],
        ['CAD', false]
      ])
      // The same rows, from someone with expenses paid in another currency.
      expect(build(bare, [inUsd({ id: 'x', merchant: 'Somewhere else' })]).map((r) => r.currencyAssumed)).toEqual([true, true])
      // A picture whose rows are in two currencies: the unread one gets a look, the read one doesn't.
      expect(build([read({ ...shown('USD') }), read({ merchant: 'Uber' })]).map((r) => r.currencyAssumed)).toEqual([false, true])
      // Remembered is not assumed.
      expect(build([read({ merchant: 'Uber' })], [saved({ id: 'u', merchant: 'Uber' }), inUsd({ id: 'x', merchant: 'Somewhere else' })])[0]).toMatchObject({ currencyHow: 'memory', currencyAssumed: false })
      // A row charged in another currency was not paid in that one: even alone in a picture in the main currency.
      expect(build([read({ chargedAmount: 16.95, chargedCurrency: 'CAD' })])[0]).toMatchObject({ currency: 'CAD', currencyAssumed: true })
    })

    it('the picture’s one currency is used for a row nothing else settles', () => {
      expect(build([read()], [], 'EUR')[0]).toMatchObject({ currency: 'EUR', currencyHow: 'picture' })
    })
  })

  describe('a row the picture says was charged in the main currency', () => {
    const [row] = build([read({ amount: 12, date: D13, merchant: 'Amazon.com', ...shown('USD'), chargedAmount: 16.95, chargedCurrency: 'CAD' })])
    const m = (over: Partial<ReviewMoney> = {}): ReviewMoney => ({ main: 'CAD', rates: {}, all: {}, ...over })

    it('keeps the charge as read, unsigned', () => {
      expect(row.charged).toEqual({ amount: 16.95, currency: 'CAD', paid: 12 })
      expect(chargedOf({ amount: -12, chargedAmount: -16.95, chargedCurrency: 'CAD' })).toEqual({ amount: 16.95, currency: 'CAD', paid: 12 })
      expect(chargedOf({ amount: 12, chargedAmount: null, chargedCurrency: null })).toBeNull()
    })

    it('comes to what was charged, at the rate behind it, with no rate asked for', () => {
      expect(rowAsCharged(row, 'CAD')).toBe(true)
      const got = rowMoney(row, m())
      expect(got).toMatchObject({ foreign: true, paid: 12, amount: 16.95 })
      expect(got.view).toMatchObject({ rate: 1.4125, origin: { how: 'charged' } })
      // Even with the day's rate at hand.
      expect(rowMoney(row, m({ rates: { [rateKey('USD', D13)]: ecb(1.4, D13) }, all: { USD: 1.5 } })).amount).toBe(16.95)
      expect(wantedRates([row], 'CAD')).toEqual([])
      expect(rowLacksRate(row, m())).toBe(false)
      expect(reviewAdds([row], m()).inputs).toEqual([
        { date: D13, amount: 16.95, originalAmount: 12, originalCurrency: 'USD', fxRate: 1.4125, cardId: null, merchant: 'Amazon.com', category: 'coffee', note: '', source: 'ai' }
      ])
    })

    it('a refund comes to a refund', () => {
      expect(rowMoney({ ...row, refund: true }, m()).amount).toBe(-16.95)
    })

    it('another amount paid follows at that rate; a rate or amount typed on the row wins', () => {
      expect(rowMoney({ ...row, amount: '20' }, m()).amount).toBe(28.25)
      expect(rowMoney({ ...row, fx: { lead: 'rate', text: '1.5' } }, m()).amount).toBe(18)
    })

    it('does nothing for a row in the main currency, or a charge in a currency that isn’t the main one', () => {
      expect(rowMoney({ ...row, currency: 'CAD' }, m())).toMatchObject({ foreign: false, amount: 12 })
      const eur = { ...row, charged: { amount: 11, currency: 'EUR', paid: 12 } }
      expect(rowAsCharged(eur, 'CAD')).toBe(false)
      expect(rowMoney(eur, m()).amount).toBeNull()
      expect(wantedRates([eur], 'CAD')).toEqual([{ from: 'USD', date: D13 }])
    })

    it('is matched with a saved expense of the same amount in the main currency from the start', () => {
      const typedByHand = saved({ id: 'cad', date: D13, amount: 16.95, merchant: 'Amazon', cardId: null })
      const [dup] = build([read({ amount: 12, date: D13, merchant: 'AMAZON.COM', ...shown('USD'), chargedAmount: 16.95, chargedCurrency: 'CAD' })], [typedByHand])
      expect(dup).toMatchObject({ include: false, duplicateOf: typedByHand })
    })
  })

  describe('rates per currency and date', () => {
    const rows = build([read({ amount: 10, date: D13, ...shown('USD') }), read({ amount: 10, date: D13, merchant: 'Fnac', ...shown('EUR') }), read({ amount: 4, date: D13, merchant: 'Uber', ...shown('USD') }), read({ amount: 3, merchant: 'Tim', ...shown('CAD') })])

    it('wantedRates: one per currency and date of the rows in another currency without a rate typed on them', () => {
      expect(wantedRates(rows, 'CAD')).toEqual([
        { from: 'USD', date: D13 },
        { from: 'EUR', date: D13 }
      ])
      const typed = rows.map((r, i) => (i === 0 ? { ...r, fx: { lead: 'rate' as const, text: '1.5' } } : r))
      expect(wantedRates(typed, 'CAD')).toEqual([
        { from: 'EUR', date: D13 },
        { from: 'USD', date: D13 }
      ])
      // Emptied while still in the box: wanted again.
      expect(wantedRates(rows.map((r, i) => (i === 0 ? { ...r, fx: { lead: 'rate' as const, text: ' ' } } : r)), 'CAD')).toHaveLength(2)
    })

    it('each row converts at its own currency’s rate, and a rate typed for one currency fills only its rows', () => {
      const m: ReviewMoney = { main: 'CAD', rates: { [rateKey('USD', D13)]: ecb(1.4, D13) }, all: { EUR: 1.6 } }
      expect(rows.map((r) => rowMoney(r, m).amount)).toEqual([14, 16, 5.6, 3])
      const noUsd: ReviewMoney = { main: 'CAD', rates: {}, all: { EUR: 1.6 } }
      expect(rows.map((r) => rowLacksRate(r, noUsd))).toEqual([true, false, true, false])
    })
  })

  describe('changing the currency of a row, or of all of them', () => {
    const [row] = build([read({ amount: 12, merchant: 'Uber' })], [inUsd({ id: 'x', merchant: 'Somewhere else' })])

    it('setRowCurrency: chosen by the person, no longer assumed', () => {
      expect(row).toMatchObject({ currency: 'CAD', currencyHow: 'main', currencyAssumed: true })
      expect(setRowCurrency(row, 'USD', 'CAD')).toMatchObject({ currency: 'USD', currencyHow: 'user', currencyAssumed: false, amount: '12.00' })
      // The one it has: only confirmed.
      expect(setRowCurrency(row, 'CAD', 'CAD')).toMatchObject({ currency: 'CAD', currencyHow: 'user', currencyAssumed: false })
      const chosen = setRowCurrency(row, 'USD', 'CAD')
      expect(setRowCurrency(chosen, 'USD', 'CAD')).toBe(chosen)
    })

    it('a rate typed for the other currency goes; an amount typed in the main one stays unless the row is now in it', () => {
      const usd = setRowCurrency(row, 'USD', 'CAD')
      expect(setRowCurrency({ ...usd, fx: { lead: 'rate', text: '1.5' } }, 'EUR', 'CAD').fx).toBeNull()
      expect(setRowCurrency({ ...usd, fx: { lead: 'converted', text: '17' } }, 'EUR', 'CAD').fx).toEqual({ lead: 'converted', text: '17' })
      expect(setRowCurrency({ ...usd, fx: { lead: 'converted', text: '17' } }, 'CAD', 'CAD').fx).toBeNull()
    })

    it('setAllCurrencies and commonCurrency: every row in one', () => {
      const rows = build([read({ ...shown('USD') }), read({ merchant: 'Uber', ...shown('CAD') })])
      expect(commonCurrency(rows)).toBeNull()
      const all = setAllCurrencies(rows, 'EUR', 'CAD')
      expect(all.map((r) => [r.currency, r.currencyHow])).toEqual([
        ['EUR', 'user'],
        ['EUR', 'user']
      ])
      expect(commonCurrency(all)).toBe('EUR')
      expect(commonCurrency([])).toBeNull()
    })
  })
})
