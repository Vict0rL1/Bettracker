import { afterEach, describe, expect, it } from 'vitest'
import type { Expense, ExpenseBudget, ExpenseCard } from '../../../shared/types'
import { monthInline, monthLabel } from './dates'
import { getLang, setLang } from './i18n'
import {
  budgetLines,
  budgetState,
  cardFilterChoices,
  cardKeyOf,
  categoryShares,
  comparisonChange,
  expensesInMonth,
  filterExpenses,
  groupExpensesByDay,
  merchantLast,
  merchantSuggestions,
  monthSpend,
  NO_CARD,
  pace,
  SERIES_INKS,
  spendChartData,
  totalBudget,
  vsLastMonth
} from './spend'

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const C = 'cccccccc-0000-4000-8000-000000000003'
const GONE = 'dddddddd-0000-4000-8000-000000000004'

const card = (id: string, name: string, createdAt: string, archived = false): ExpenseCard => ({ id, name, last4: '', kind: 'credit', archived, createdAt, updatedAt: createdAt })
const CARDS = [card(B, 'Visa', '2026-02-01T00:00:00Z'), card(A, 'Amex', '2026-01-01T00:00:00Z'), card(C, 'Old', '2026-03-01T00:00:00Z', true)]

let seq = 0
const exp = (over: Partial<Expense> & { date: string; amount: number }): Expense => {
  seq++
  const t = `${over.date}T${String(seq % 24).padStart(2, '0')}:00:00.000Z`
  return { id: `e${String(seq).padStart(3, '0')}`, originalAmount: null, originalCurrency: null, fxRate: null, cardId: null, merchant: '', category: 'other', note: '', source: 'manual', createdAt: t, updatedAt: t, ...over }
}
const budget = (scope: ExpenseBudget['scope'], target: string, monthlyLimit: number): ExpenseBudget => ({ id: `${scope}:${target}`, scope, target, monthlyLimit, createdAt: '2026-01-01', updatedAt: '2026-01-01' })

const NOV = { year: 2026, month: 10 }
const TODAY = '2026-11-17'

afterEach(() => setLang('en'))

describe('monthSpend', () => {
  const list = [
    exp({ date: '2026-11-03', amount: 0.1, cardId: A, category: 'coffee' }),
    exp({ date: '2026-11-03', amount: 0.2, cardId: A, category: 'coffee' }),
    exp({ date: '2026-11-04', amount: 50, cardId: B, category: 'groceries' }),
    exp({ date: '2026-11-05', amount: -12.5, cardId: B, category: 'shopping' }),
    exp({ date: '2026-11-06', amount: 7, cardId: GONE, category: 'food' }),
    exp({ date: '2026-11-07', amount: 3, cardId: C, category: 'mystery' as never }),
    exp({ date: '2026-10-31', amount: 1000, cardId: A }),
    exp({ date: '2026-12-01', amount: 1000, cardId: A })
  ]

  it('totals the month to the cent, refunds lowering it', () => {
    const m = monthSpend(list, NOV, CARDS)
    expect(m).toMatchObject({ total: 47.8, spent: 60.3, refunded: 12.5, count: 6 })
  })

  it('totals per card: an unknown card is "none", an archived one keeps its key', () => {
    const m = monthSpend(list, NOV, CARDS)
    expect(Object.fromEntries(m.byCard)).toEqual({ [A]: 0.3, [B]: 37.5, [NO_CARD]: 7, [C]: 3 })
  })

  it('totals per category, an unknown one as other', () => {
    const m = monthSpend(list, NOV, CARDS)
    expect(Object.fromEntries(m.byCategory)).toEqual({ coffee: 0.3, groceries: 50, shopping: -12.5, food: 7, other: 3 })
  })

  it('an empty month is all zeros', () => {
    expect(monthSpend([], NOV, CARDS)).toMatchObject({ total: 0, spent: 0, refunded: 0, count: 0 })
    expect(expensesInMonth(list, { year: 2026, month: 0 })).toEqual([])
  })

  it('cardKeyOf: a known card, else none', () => {
    const known = new Set([A])
    expect(cardKeyOf(exp({ date: TODAY, amount: 1, cardId: A }), known)).toBe(A)
    expect(cardKeyOf(exp({ date: TODAY, amount: 1, cardId: GONE }), known)).toBe(NO_CARD)
    expect(cardKeyOf(exp({ date: TODAY, amount: 1 }), known)).toBe(NO_CARD)
  })
})

describe('pace', () => {
  it('the current month: the average so far, and where the month ends at this pace', () => {
    expect(pace(170, NOV, TODAY)).toEqual({ daysCounted: 17, dailyAverage: 10, projected: 300, state: 'current' })
  })

  it('a past month: the average over all its days, no projection', () => {
    expect(pace(310, { year: 2026, month: 9 }, TODAY)).toEqual({ daysCounted: 31, dailyAverage: 10, projected: null, state: 'past' })
    expect(pace(100, { year: 2025, month: 11 }, TODAY).state).toBe('past')
  })

  it('a future month: nothing to say', () => {
    expect(pace(0, { year: 2026, month: 11 }, TODAY)).toEqual({ daysCounted: 0, dailyAverage: null, projected: null, state: 'future' })
    expect(pace(0, { year: 2027, month: 0 }, TODAY).state).toBe('future')
  })

  it('rounds to the cent', () => {
    expect(pace(10, NOV, '2026-11-03')).toMatchObject({ dailyAverage: 3.33, projected: 100 })
  })
})

describe('vsLastMonth', () => {
  const OCT = { year: 2026, month: 9 }
  const list = [
    exp({ date: '2026-10-03', amount: 40 }),
    exp({ date: '2026-10-17', amount: 60 }),
    exp({ date: '2026-10-18', amount: 500 }),
    exp({ date: '2026-10-31', amount: 0.1 }),
    exp({ date: '2026-11-02', amount: 100 }),
    exp({ date: '2026-11-17', amount: 20.2 }),
    exp({ date: '2026-11-10', amount: -8.2 }),
    exp({ date: '2026-09-30', amount: 999 })
  ]

  it('the current month: both months up to today’s day number, never a part of a month against a whole one', () => {
    expect(vsLastMonth(list, NOV, TODAY)).toEqual({ previousMonth: OCT, previousThrough: '2026-10-17', current: 112, previous: 100, diff: 12, ratio: 0.12 })
    // A day later last month's big day counts too.
    expect(vsLastMonth(list, NOV, '2026-11-18')).toMatchObject({ previousThrough: '2026-10-18', current: 112, previous: 600, diff: -488 })
    // An expense dated after today is in the month's total, not in what is compared.
    expect(vsLastMonth(list, NOV, '2026-11-02')).toMatchObject({ previousThrough: '2026-10-02', current: 100, previous: 0, diff: 100, ratio: null })
  })

  it('a past month: the whole of it against the whole month before', () => {
    const whole = vsLastMonth(list, OCT, TODAY)
    expect(whole).toMatchObject({ previousMonth: { year: 2026, month: 8 }, previousThrough: null, current: 600.1, previous: 999, diff: -398.9 })
    expect(whole?.ratio).toBeCloseTo(-398.9 / 999, 12)
  })

  it('the 31st against a shorter month counts that month to its last day', () => {
    const march = [exp({ date: '2027-02-28', amount: 10 }), exp({ date: '2027-02-01', amount: 5 }), exp({ date: '2027-03-31', amount: 30 })]
    expect(vsLastMonth(march, { year: 2027, month: 2 }, '2027-03-31')).toMatchObject({ previousMonth: { year: 2027, month: 1 }, previousThrough: '2027-02-28', current: 30, previous: 15, diff: 15, ratio: 1 })
  })

  it('January looks back at December of the year before', () => {
    const jan = [exp({ date: '2026-12-05', amount: 50 }), exp({ date: '2027-01-04', amount: 25 })]
    expect(vsLastMonth(jan, { year: 2027, month: 0 }, '2027-01-10')).toMatchObject({ previousMonth: { year: 2026, month: 11 }, previousThrough: '2026-12-10', current: 25, previous: 50, ratio: -0.5 })
  })

  it('nothing to compare with: no expenses at all the month before, or a month that has not started', () => {
    expect(vsLastMonth(list, { year: 2026, month: 8 }, TODAY)).toBeNull()
    expect(vsLastMonth([], NOV, TODAY)).toBeNull()
    expect(vsLastMonth(list, { year: 2026, month: 11 }, TODAY)).toBeNull()
    // Expenses the month before, none of them yet by this day: still compared (by the amount, see comparisonChange).
    expect(vsLastMonth(list, NOV, '2026-11-01')).toMatchObject({ current: 0, previous: 0, diff: 0, ratio: null })
  })

  it('sums in cents, and a month of refunds gives no share', () => {
    const cents = [exp({ date: '2026-10-01', amount: 0.1 }), exp({ date: '2026-10-02', amount: 0.2 }), exp({ date: '2026-11-01', amount: 0.3 })]
    expect(vsLastMonth(cents, NOV, TODAY)).toMatchObject({ current: 0.3, previous: 0.3, diff: 0, ratio: 0 })
    const refunds = [exp({ date: '2026-10-01', amount: -20 }), exp({ date: '2026-11-01', amount: 5 })]
    expect(vsLastMonth(refunds, NOV, TODAY)).toMatchObject({ current: 5, previous: -20, diff: 25, ratio: null })
  })
})

describe('comparisonChange', () => {
  it('more or less, by a whole percentage', () => {
    expect(comparisonChange({ diff: 12, ratio: 0.12 })).toEqual({ direction: 'more', pct: 12 })
    expect(comparisonChange({ diff: -488, ratio: -488 / 600 })).toEqual({ direction: 'less', pct: 81 })
    expect(comparisonChange({ diff: -50, ratio: -1 })).toEqual({ direction: 'less', pct: 100 })
  })

  it('the same only to the cent; a difference under half a percent is still one (0, said as "<1%")', () => {
    expect(comparisonChange({ diff: 0, ratio: 0 })).toEqual({ direction: 'same' })
    expect(comparisonChange({ diff: 0, ratio: null })).toEqual({ direction: 'same' })
    expect(comparisonChange({ diff: 0.01, ratio: 0.00001 })).toEqual({ direction: 'more', pct: 0 })
  })

  it('by the amount alone when the month before gives no share: nothing spent by then, or ten times less', () => {
    expect(comparisonChange({ diff: 100, ratio: null })).toEqual({ direction: 'more', pct: null })
    expect(comparisonChange({ diff: 499, ratio: 499 })).toEqual({ direction: 'more', pct: null })
    expect(comparisonChange({ diff: 99.9, ratio: 9.99 })).toEqual({ direction: 'more', pct: 999 })
  })
})

describe('budgetState', () => {
  it('none without a limit', () => {
    expect(budgetState(50, null)).toEqual({ level: 'none', spent: 50, limit: null, left: null, ratio: 0 })
  })

  it('ok below 80 %, near from exactly 80 % up to the limit itself, over past it', () => {
    expect(budgetState(79.99, 100)).toMatchObject({ level: 'ok', left: 20.01 })
    expect(budgetState(80, 100)).toMatchObject({ level: 'near', ratio: 0.8 })
    expect(budgetState(100, 100)).toMatchObject({ level: 'near', left: 0 })
    expect(budgetState(100.01, 100)).toMatchObject({ level: 'over', left: -0.01 })
  })

  it('a month that got money back counts as nothing spent', () => {
    expect(budgetState(-20, 100)).toMatchObject({ level: 'ok', ratio: 0, left: 120 })
  })
})

describe('budgetLines and totalBudget', () => {
  const list = [
    exp({ date: '2026-11-03', amount: 85, cardId: A, category: 'food' }),
    exp({ date: '2026-11-03', amount: 4.5, category: 'coffee' })
  ]
  const budgets = [
    budget('category', 'food', 100),
    budget('card', GONE, 10),
    budget('category', 'coffee', 4),
    budget('card', A, 500),
    budget('total', '', 100),
    budget('card', B, 50)
  ]

  it('total first, then cards in card order (skipping cards this device doesn’t know), then categories in list order', () => {
    const lines = budgetLines(budgets, monthSpend(list, NOV, CARDS), CARDS)
    expect(lines.map((l) => [l.scope, l.budget.target])).toEqual([
      ['total', ''],
      ['card', B],
      ['card', A],
      ['category', 'coffee'],
      ['category', 'food']
    ])
    expect(lines.map((l) => l.label)).toEqual([{ key: 'budget.total' }, { text: 'Visa' }, { text: 'Amex' }, { key: 'cat.coffee' }, { key: 'cat.food' }])
    expect(lines.map((l) => l.state.level)).toEqual(['near', 'ok', 'ok', 'over', 'near'])
    expect(lines[0].state).toMatchObject({ spent: 89.5, limit: 100, left: 10.5 })
  })

  it('totalBudget: the one for the whole month, or none', () => {
    expect(totalBudget(budgets)?.monthlyLimit).toBe(100)
    expect(totalBudget([budget('card', A, 5)])).toBeNull()
  })
})

describe('categoryShares', () => {
  it('categories with a net, largest first, each a share of what was spent', () => {
    const list = [
      exp({ date: '2026-11-03', amount: 30, category: 'food' }),
      exp({ date: '2026-11-03', amount: 10, category: 'coffee' }),
      exp({ date: '2026-11-03', amount: 10, category: 'transport' }),
      exp({ date: '2026-11-03', amount: -5, category: 'shopping' }),
      exp({ date: '2026-11-04', amount: 5, category: 'home' }),
      exp({ date: '2026-11-04', amount: -5, category: 'home' })
    ]
    expect(categoryShares(monthSpend(list, NOV, []))).toEqual([
      { category: 'food', amount: 30, share: 30 / 55 },
      { category: 'coffee', amount: 10, share: 10 / 55 },
      { category: 'transport', amount: 10, share: 10 / 55 },
      { category: 'shopping', amount: -5, share: 0 }
    ])
  })
})

describe('spendChartData', () => {
  const list = [
    exp({ date: '2026-11-02', amount: 10, cardId: B }),
    exp({ date: '2026-11-02', amount: 5, cardId: A }),
    exp({ date: '2026-11-03', amount: 2.5 }),
    exp({ date: '2026-11-03', amount: 4, cardId: GONE }),
    exp({ date: '2026-11-05', amount: -8, cardId: A }),
    exp({ date: '2026-10-10', amount: 3, cardId: C })
  ]

  it('series: cards with spending in card createdAt order, then "No card", dashed', () => {
    const { series } = spendChartData(list, CARDS, NOV, TODAY)
    expect(series).toEqual([
      { key: `s_${A}`, cardId: A, name: 'Amex', ink: SERIES_INKS[0], dashed: false },
      { key: `s_${B}`, cardId: B, name: 'Visa', ink: SERIES_INKS[1], dashed: false },
      { key: 's_none', cardId: null, name: null, ink: 'var(--series-none)', dashed: true }
    ])
  })

  it('keeps a card’s ink from month to month (its place among all cards)', () => {
    const oct = spendChartData(list, CARDS, { year: 2026, month: 9 }, TODAY).series
    expect(oct).toEqual([{ key: `s_${C}`, cardId: C, name: 'Old', ink: SERIES_INKS[2], dashed: false }])
    const many = Array.from({ length: 6 }, (_, i) => card(`0000000${i}-0000-4000-8000-000000000000`, `C${i}`, `2026-01-0${i + 1}T00:00:00Z`))
    const fifth = spendChartData([exp({ date: '2026-11-01', amount: 1, cardId: many[4].id })], many, NOV, TODAY).series
    expect(fifth[0].ink).toBe(SERIES_INKS[0])
  })

  it('daily: every day of the month with that day’s net per series, a refund day negative', () => {
    const { daily } = spendChartData(list, CARDS, NOV, TODAY)
    expect(daily).toHaveLength(30)
    expect(daily[1]).toEqual({ date: '2026-11-02', day: 2, total: 15, cumulative: 15, [`s_${A}`]: 5, [`s_${B}`]: 10, s_none: 0 })
    expect(daily[2]).toMatchObject({ day: 3, total: 6.5, cumulative: 21.5, s_none: 6.5 })
    expect(daily[4]).toMatchObject({ day: 5, total: -8, [`s_${A}`]: -8, cumulative: 13.5 })
    // After today the month has not got there.
    expect(daily[16].cumulative).toBe(13.5)
    expect(daily[17]).toMatchObject({ day: 18, total: 0, cumulative: null })
  })

  it('cumulative: running totals per series, up to today in the current month', () => {
    const { cumulative } = spendChartData(list, CARDS, NOV, TODAY)
    expect(cumulative).toHaveLength(17)
    expect(cumulative[0]).toMatchObject({ day: 1, total: 0, cumulative: 0, [`s_${A}`]: 0 })
    expect(cumulative[4]).toEqual({ date: '2026-11-05', day: 5, total: -8, cumulative: 13.5, [`s_${A}`]: -3, [`s_${B}`]: 10, s_none: 6.5 })
    expect(cumulative[16]).toMatchObject({ day: 17, cumulative: 13.5 })
  })

  it('every day of a past month, none of a future one', () => {
    expect(spendChartData(list, CARDS, { year: 2026, month: 9 }, TODAY).cumulative).toHaveLength(31)
    const future = spendChartData(list, CARDS, { year: 2026, month: 11 }, TODAY)
    expect(future.cumulative).toEqual([])
    expect(future.daily).toHaveLength(31)
    expect(future.daily.every((p) => p.cumulative === null)).toBe(true)
  })

  it('min dips below 0 with refunds; max is the highest running total; maxDaily the highest day', () => {
    const d = spendChartData(list, CARDS, NOV, TODAY)
    // Daily: −8 on the 5th; cumulative: Amex alone is −3 from the 5th (the lowest level of the stack).
    expect(d.min).toBe(-8)
    expect(d.max).toBe(21.5)
    expect(d.maxDaily).toBe(15)
    const none = spendChartData([], CARDS, NOV, TODAY)
    expect([none.series, none.min, none.max, none.maxDaily]).toEqual([[], 0, 0, 0])
  })

  it('adds cents exactly', () => {
    const d = spendChartData([exp({ date: '2026-11-01', amount: 0.1 }), exp({ date: '2026-11-01', amount: 0.2 })], [], NOV, TODAY)
    expect(d.daily[0].total).toBe(0.3)
    expect(d.cumulative[16].cumulative).toBe(0.3)
  })
})

describe('filterExpenses', () => {
  const list = [
    exp({ date: '2026-11-03', amount: 4.5, cardId: A, category: 'coffee', merchant: 'Café Central' }),
    exp({ date: '2026-11-03', amount: 20, cardId: GONE, category: 'food', note: 'cena con Ána' }),
    exp({ date: '2026-11-03', amount: 9, category: 'food', merchant: 'Taco Bell' })
  ]
  const known = new Set([A, B])
  const all = { card: 'all', category: 'all', query: '' } as const

  it('by card, "none" taking the rows with no card or an unknown one', () => {
    expect(filterExpenses(list, { ...all, card: A }, known)).toEqual([list[0]])
    expect(filterExpenses(list, { ...all, card: NO_CARD }, known)).toEqual([list[1], list[2]])
    expect(filterExpenses(list, all, known)).toEqual(list)
  })

  it('by category', () => {
    expect(filterExpenses(list, { ...all, category: 'food' }, known)).toEqual([list[1], list[2]])
  })

  it('by words in the merchant or the note, ignoring case and accents', () => {
    expect(filterExpenses(list, { ...all, query: 'cafe' }, known)).toEqual([list[0]])
    expect(filterExpenses(list, { ...all, query: '  ANA ' }, known)).toEqual([list[1]])
    expect(filterExpenses(list, { ...all, query: 'taco', category: 'coffee' }, known)).toEqual([])
  })
})

describe('groupExpensesByDay', () => {
  it('days newest first, each with its net total and its expenses newest first', () => {
    const first = exp({ date: '2026-11-03', amount: 4.5, createdAt: '2026-11-03T08:00:00Z' })
    const second = exp({ date: '2026-11-03', amount: -1.2, createdAt: '2026-11-03T09:00:00Z' })
    const other = exp({ date: '2026-11-05', amount: 0.1 })
    const days = groupExpensesByDay([first, other, second])
    expect(days.map((d) => d.date)).toEqual(['2026-11-05', '2026-11-03'])
    expect(days[1]).toEqual({ date: '2026-11-03', total: 3.3, items: [second, first] })
  })

  it('a page of the list: only the newest rows, but a day split by the page keeps the total of all its rows', () => {
    const late = exp({ date: '2026-11-05', amount: 10, createdAt: '2026-11-05T09:00:00Z' })
    const mid = exp({ date: '2026-11-04', amount: 7, createdAt: '2026-11-04T12:00:00Z' })
    const early = exp({ date: '2026-11-04', amount: 3, createdAt: '2026-11-04T08:00:00Z' })
    const old = exp({ date: '2026-11-01', amount: 1 })
    const list = [old, early, late, mid]
    expect(groupExpensesByDay(list, 2)).toEqual([
      { date: '2026-11-05', total: 10, items: [late] },
      { date: '2026-11-04', total: 10, items: [mid] }
    ])
    expect(groupExpensesByDay(list, 3).map((d) => [d.date, d.total, d.items.length])).toEqual([
      ['2026-11-05', 10, 1],
      ['2026-11-04', 10, 2]
    ])
    expect(groupExpensesByDay(list, 4)).toEqual(groupExpensesByDay(list))
    expect(groupExpensesByDay(list, 60)).toEqual(groupExpensesByDay(list))
    expect(groupExpensesByDay(list, 0)).toEqual([])
  })
})

describe('cardFilterChoices', () => {
  // CARDS: Visa (B) and Amex (A) active, Old (C) archived.
  const month = [exp({ date: '2026-11-03', amount: 4, cardId: A })]
  const ids = (r: { cards: ExpenseCard[] }): string[] => r.cards.map((c) => c.id)

  it('the active cards, and an archived one only when the month uses it', () => {
    expect(cardFilterChoices(CARDS, month, 'all')).toEqual({ cards: [CARDS[0], CARDS[1]], value: 'all' })
    expect(ids(cardFilterChoices(CARDS, [...month, exp({ date: '2026-11-04', amount: 2, cardId: C })], 'all'))).toEqual([B, A, C])
    expect(cardFilterChoices(CARDS, month, NO_CARD)).toMatchObject({ value: NO_CARD })
  })

  it('an archived card chosen in another month is still offered and shown, never "All cards" while filtering by it', () => {
    expect(cardFilterChoices(CARDS, month, C)).toEqual({ cards: CARDS, value: C })
    expect(cardFilterChoices(CARDS, [], C)).toEqual({ cards: CARDS, value: C })
    expect(cardFilterChoices(CARDS, [], B)).toMatchObject({ value: B })
  })

  it('a card this device no longer knows (deleted since) filters nothing, as the box says', () => {
    expect(cardFilterChoices(CARDS, month, GONE)).toEqual({ cards: [CARDS[0], CARDS[1]], value: 'all' })
    expect(cardFilterChoices([], month, A)).toEqual({ cards: [], value: 'all' })
  })
})

describe('merchantSuggestions', () => {
  it('each merchant once, the most recent first, no blanks, at most max', () => {
    const list = [
      exp({ date: '2026-11-01', amount: 1, merchant: 'Uber' }),
      exp({ date: '2026-11-05', amount: 1, merchant: 'Starbucks' }),
      exp({ date: '2026-11-03', amount: 1, merchant: 'uber ' }),
      exp({ date: '2026-11-04', amount: 1, merchant: '' }),
      exp({ date: '2026-11-02', amount: 1, merchant: 'Walmart' })
    ]
    expect(merchantSuggestions(list)).toEqual(['Starbucks', 'uber', 'Walmart'])
    expect(merchantSuggestions(list, 2)).toEqual(['Starbucks', 'uber'])
  })
})

describe('merchantLast', () => {
  const list = [
    exp({ date: '2026-11-01', amount: 4, merchant: 'Starbucks', category: 'food', cardId: A }),
    exp({ date: '2026-11-05', amount: 5, merchant: 'starbucks ', category: 'coffee', cardId: B }),
    exp({ date: '2026-11-03', amount: 6, merchant: 'Starbucks', category: 'other', cardId: null }),
    exp({ date: '2026-11-04', amount: 20, merchant: 'Uber', category: 'transport', cardId: null }),
    exp({ date: '2026-11-06', amount: 30, merchant: 'Uber Eats', category: 'food', cardId: A }),
    exp({ date: '2026-11-07', amount: 9, merchant: '', category: 'health', cardId: A })
  ]

  it('the category and card of the merchant’s most recent expense, case and outer spaces aside', () => {
    expect(merchantLast(list, 'Starbucks')).toEqual({ category: 'coffee', cardId: B })
    expect(merchantLast(list, '  STARBUCKS')).toEqual({ category: 'coffee', cardId: B })
  })

  it('the whole name, never the start of one: "Uber" is not "Uber Eats"', () => {
    expect(merchantLast(list, 'Uber')).toEqual({ category: 'transport', cardId: null })
    expect(merchantLast(list, 'uber eats')).toEqual({ category: 'food', cardId: A })
    expect(merchantLast(list, 'Ube')).toBeNull()
    expect(merchantLast(list, 'Uber Eats Montréal')).toBeNull()
  })

  it('no merchant, or one not typed before: nothing (an expense with no merchant is no match for an empty box)', () => {
    expect(merchantLast(list, '')).toBeNull()
    expect(merchantLast(list, '   ')).toBeNull()
    expect(merchantLast(list, 'Walmart')).toBeNull()
    expect(merchantLast([], 'Starbucks')).toBeNull()
  })

  it('on the same day, the one added last; a category this app doesn’t know is "other"', () => {
    const sameDay = [
      { ...exp({ date: '2026-11-05', amount: 1, merchant: 'Metro', category: 'groceries', cardId: A }), createdAt: '2026-11-05T09:00:00.000Z' },
      { ...exp({ date: '2026-11-05', amount: 1, merchant: 'Metro', category: 'transport', cardId: B }), createdAt: '2026-11-05T18:00:00.000Z' }
    ]
    expect(merchantLast(sameDay, 'metro')).toEqual({ category: 'transport', cardId: B })
    expect(merchantLast([exp({ date: '2026-11-05', amount: 1, merchant: 'X', category: 'pets' as Expense['category'] })], 'x')).toEqual({ category: 'other', cardId: null })
  })
})

describe('monthInline', () => {
  it('is the month label inside a sentence: lowercase in Spanish, as monthLabel in English', () => {
    const before = getLang()
    setLang('es')
    expect(monthInline(NOV)).toBe('noviembre de 2026')
    expect(monthLabel(NOV)).toBe('Noviembre de 2026')
    setLang('en')
    expect(monthInline(NOV)).toBe('November 2026')
    expect(monthInline(NOV)).toBe(monthLabel(NOV))
    setLang(before)
  })
})
