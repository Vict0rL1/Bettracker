import { beforeEach, describe, expect, it } from 'vitest'
import { EXPENSE_CATEGORIES, type Expense, type ExpenseBudget, type ExpenseCard } from '../../../shared/types'
import { BUDGETS_SPEC, CARDS_SPEC, EXPENSES_SPEC } from '../data/expenseSpecs'
import { CASINO_GAMES, CASINO_SPORT, isCasino } from '../lib/casino'
import { addDays, addMonths, monthPrefix, type MonthKey } from '../lib/dates'
import { paidInAnother } from '../lib/expenseForm'
import { convert } from '../lib/fx'
import { budgetLines, monthSpend, vsLastMonth } from '../lib/spend'
import { budgetId } from '../lib/stableId'
import { normalizeBudget, normalizeCard, normalizeExpense, normalizeInput, normalizeMove } from '../lib/validate'
import { DEMO_USER, demoHasData } from './demo'
import { loadSampleData, sampleData, type SampleData } from './sample'

const OPTS = { userId: DEMO_USER.id, lang: 'en' as const }
/** 3 pm on that local day. */
const at = (date: string): Date => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d, 15, 0, 0)
}
const NOW = at('2026-11-18')
const TODAY = '2026-11-18'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const expensesOf = (s: SampleData): Expense[] => s.expenses.map((r) => EXPENSES_SPEC.fromRow(r))
const cardsOf = (s: SampleData): ExpenseCard[] => s.cards.map((r) => CARDS_SPEC.fromRow(r))
const budgetsOf = (s: SampleData): ExpenseBudget[] => s.budgets.map((r) => BUDGETS_SPEC.fromRow(r))
const monthOf = (date: string): MonthKey => ({ year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)) - 1 })

describe('sampleData', () => {
  const s = sampleData(NOW, OPTS)

  it('is the same every time it is made, and only its dates move with the day', () => {
    expect(sampleData(NOW, OPTS)).toEqual(s)
    const later = sampleData(at('2027-02-03'), OPTS)
    const settled = (x: SampleData) => x.bets.map((b) => [b.id, b.amount, b.stake, b.odds, b.closing_odds, b.status, b.book, b.bet_type])
    expect(settled(later)).toEqual(settled(s))
    expect(later.bets.map((b) => b.date)).not.toEqual(s.bets.map((b) => b.date))
    expect(later.cards.map((c) => [c.id, c.name, c.last4])).toEqual(s.cards.map((c) => [c.id, c.name, c.last4]))
    expect(later.budgets.map((b) => [b.id, b.monthly_limit])).toEqual(s.budgets.map((b) => [b.id, b.monthly_limit]))
  })

  it('about sixty bets over two months: won, lost, pushed and still open, with their sport, book, type and odds', () => {
    const sports = s.bets.filter((b) => !isCasino(String(b.sport)))
    expect(sports).toHaveLength(60)
    const count = (status: string): number => sports.filter((b) => b.status === status).length
    expect(count('pending')).toBe(4)
    expect(count('won')).toBeGreaterThan(15)
    expect(count('lost')).toBeGreaterThan(15)
    expect(count('push')).toBeGreaterThan(0)
    expect(count('won') + count('lost') + count('push') + count('pending')).toBe(60)
    for (const b of sports) {
      expect(String(b.date) <= TODAY && String(b.date) >= addDays(TODAY, -60), `${String(b.date)} within the last two months`).toBe(true)
      expect(['NBA', 'NFL', 'NHL', 'Soccer']).toContain(b.sport)
      expect(String(b.book)).not.toBe('')
      expect(String(b.bet_type)).not.toBe('')
      expect(b.odds as number).toBeGreaterThan(1)
      expect(b.stake as number).toBeGreaterThan(0)
    }
    // The open ones are today's and yesterday's: nothing older is still waiting.
    for (const b of s.bets.filter((x) => x.status === 'pending')) expect(String(b.date) >= addDays(TODAY, -1)).toBe(true)
    // A believable record: neither a fortune nor a ruin.
    const net = s.bets.reduce((sum, b) => sum + ((b.amount as number | null) ?? 0), 0)
    expect(Math.abs(net)).toBeLessThan(300)
  })

  it('a few casino plays at Stake: a game, won or lost by its sign, no odds, the wager when typed, netting to nothing', () => {
    const plays = s.bets.filter((b) => isCasino(String(b.sport)))
    expect(plays).toHaveLength(6)
    for (const b of plays) {
      expect(b).toMatchObject({ sport: CASINO_SPORT, book: 'Stake', odds: null, closing_odds: null })
      expect(CASINO_GAMES as readonly unknown[]).toContain(b.bet_type)
      expect(b.status).toBe((b.amount as number) > 0 ? 'won' : 'lost')
      if (b.stake !== null && b.status === 'lost') expect(-(b.amount as number)).toBeLessThanOrEqual(b.stake as number)
      // Never from today or yesterday: the bet logged last is a sports one.
      expect(String(b.date) <= addDays(TODAY, -2)).toBe(true)
    }
    expect(plays.some((b) => b.stake === null)).toBe(true)
    expect(plays.some((b) => b.stake !== null)).toBe(true)
    expect(Math.round(plays.reduce((sum, b) => sum + (b.amount as number), 0) * 100)).toBe(0)
  })

  it('every bet is one the app would have stored as it is', () => {
    for (const b of s.bets) {
      const clean = normalizeInput({
        date: b.date as string,
        amount: b.amount as number | null,
        stake: b.stake as number,
        odds: b.odds as number,
        closingOdds: b.closing_odds as number | null,
        status: b.status as 'won',
        note: b.note as string,
        sport: b.sport as string,
        book: b.book as string,
        betType: b.bet_type as string
      })
      expect(clean).toEqual({ date: b.date, amount: b.amount, stake: b.stake, odds: b.odds, closingOdds: b.closing_odds, status: b.status, note: b.note, sport: b.sport, book: b.book, betType: b.bet_type })
      // A win pays what its price says, a loss costs the stake (a casino play's result is typed as it came).
      if (isCasino(String(b.sport))) continue
      if (b.status === 'won') expect(b.amount).toBeCloseTo((b.stake as number) * ((b.odds as number) - 1), 2)
      if (b.status === 'lost') expect(b.amount).toBe(-(b.stake as number))
    }
  })

  it('a starting bankroll, a deposit, and the expense currency in Canadian dollars', () => {
    expect(s.settings).toMatchObject({ user_id: DEMO_USER.id, starting_bankroll: 500, expense_currency: 'CAD', odds_format: 'american' })
    expect(s.moves).toHaveLength(1)
    expect(normalizeMove({ date: s.moves[0].date as string, amount: s.moves[0].amount as number, note: s.moves[0].note as string })).toMatchObject({ amount: 250 })
    expect(s.moves[0].amount).toBeGreaterThan(0)
  })

  it('two cards and four budgets (the month, a card, two categories), as the app would have stored them', () => {
    const cards = cardsOf(s)
    expect(cards.map((c) => c.name)).toEqual(['Visa TD', 'Amex Cobalt'])
    for (const c of cards) expect(normalizeCard({ name: c.name, last4: c.last4, kind: c.kind, archived: c.archived })).toEqual({ name: c.name, last4: c.last4, kind: c.kind, archived: false })
    const budgets = budgetsOf(s)
    expect(budgets.map((b) => [b.scope, b.target])).toEqual([
      ['total', ''],
      ['card', cards[0].id],
      ['category', 'subscriptions'],
      ['category', 'entertainment']
    ])
    for (const b of budgets) {
      expect(normalizeBudget({ scope: b.scope, target: b.target, monthlyLimit: b.monthlyLimit })).toEqual({ scope: b.scope, target: b.target, monthlyLimit: b.monthlyLimit })
      // The id the app itself makes for that budget: an edit in the demo meets this row.
      expect(b.id).toBe(budgetId(DEMO_USER.id, b.scope, b.target))
    }
  })

  it('about forty expenses over this month and the last, each one the app would have stored as it is', () => {
    const list = expensesOf(s)
    expect(list.length).toBeGreaterThanOrEqual(40)
    expect(list.length).toBeLessThanOrEqual(50)
    const months = new Set(list.map((e) => e.date.slice(0, 7)))
    expect([...months].sort()).toEqual(['2026-10', '2026-11'])
    const known = new Set(s.cards.map((c) => c.id))
    for (const e of list) {
      expect(e.date <= TODAY).toBe(true)
      expect(e.merchant).not.toBe('')
      expect(e.cardId === null || known.has(e.cardId)).toBe(true)
      expect(normalizeExpense(EXPENSES_SPEC.toInput(e))).toEqual(EXPENSES_SPEC.toInput(e))
    }
    // Every category shows somewhere, so every glyph does.
    expect(new Set(list.map((e) => e.category)).size).toBe(EXPENSE_CATEGORIES.length)
  })

  it('a few paid in US dollars, with all three of what was paid, its currency and a rate of those weeks; a refund; rows read by AI; one with no card', () => {
    const list = expensesOf(s)
    const usd = list.filter((e) => paidInAnother(e, 'CAD'))
    expect(usd.length).toBeGreaterThanOrEqual(4)
    expect(usd.length).toBeLessThanOrEqual(10)
    for (const e of usd) {
      expect(e.originalCurrency).toBe('USD')
      expect(e.fxRate).toBeGreaterThanOrEqual(1.38)
      expect(e.fxRate).toBeLessThanOrEqual(1.41)
      // The amount is the conversion the app itself would have made, in CAD.
      expect(e.amount).toBe(convert(e.originalAmount, e.fxRate, 2))
      expect(e.amount).toBeGreaterThan(e.originalAmount)
    }
    // No row has only part of an original: the raw rows too.
    for (const r of s.expenses) expect([r.original_amount, r.original_currency, r.fx_rate].filter((v) => v === null).length % 3).toBe(0)
    expect(list.some((e) => e.amount < 0)).toBe(true)
    expect(list.filter((e) => e.source === 'ai').length).toBeGreaterThanOrEqual(2)
    expect(list.some((e) => e.cardId === null)).toBe(true)
  })

  it('every id is a UUID and no two rows share one', () => {
    const ids = [...s.bets, ...s.moves, ...s.cards, ...s.expenses, ...s.budgets].map((r) => String(r.id))
    for (const id of ids) expect(id).toMatch(UUID)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('nothing is stamped after the moment it was made: a row from the future would win every conflict against the user’s edits', () => {
    for (const now of [NOW, new Date(2026, 10, 18, 0, 0, 30), new Date(2026, 10, 18, 23, 59, 59)]) {
      const made = sampleData(now, OPTS)
      const stamps = [made.settings, ...made.bets, ...made.moves, ...made.cards, ...made.expenses, ...made.budgets].flatMap((r) => [r.updated_at, r.created_at].filter((v) => v !== undefined))
      expect(stamps.length).toBeGreaterThan(200)
      for (const stamp of stamps) expect(Date.parse(String(stamp))).toBeLessThan(now.getTime())
    }
  })

  it('the few words that are not names follow the language, and nothing else does', () => {
    const es = sampleData(NOW, { ...OPTS, lang: 'es' })
    expect(es.expenses.map((e) => e.note)).toContain('entradas del concierto')
    expect(s.expenses.map((e) => e.note)).toContain('concert tickets')
    expect(es.expenses.map((e) => [e.id, e.amount, e.merchant])).toEqual(s.expenses.map((e) => [e.id, e.amount, e.merchant]))
    expect(new Set(es.bets.map((b) => b.sport))).toEqual(new Set(['NBA', 'NFL', 'NHL', 'Fútbol', 'Casino']))
    expect(es.bets.map((b) => [b.id, b.amount, b.odds, b.date])).toEqual(s.bets.map((b) => [b.id, b.amount, b.odds, b.date]))
  })

  // The demo is there to be looked at: whatever day it is loaded on, the month under way shows a budget near its
  // limit and one over it, a comparison with the month before, and the month before is whole.
  it('on every day of the year: one budget near its limit, one over, last month whole, and nothing dated after today', () => {
    let day = '2027-12-28'
    for (let i = 0; i < 400; i++) {
      day = addDays(day, 1)
      const made = sampleData(at(day), OPTS)
      const list = expensesOf(made)
      const cards = cardsOf(made)
      const ym = monthOf(day)
      const lines = budgetLines(budgetsOf(made), monthSpend(list, ym, cards), cards)
      const level = (target: string): string | undefined => lines.find((l) => l.budget.target === target)?.state.level
      expect(level('subscriptions'), `subscriptions on ${day}`).toBe('near')
      expect(level('entertainment'), `entertainment on ${day}`).toBe('over')
      expect(lines).toHaveLength(4)
      expect(list.every((e) => e.date <= day), `nothing after ${day}`).toBe(true)
      const last = addMonths(ym, -1)
      expect(list.filter((e) => e.date.startsWith(monthPrefix(last))), `last month on ${day}`).toHaveLength(28)
      expect(vsLastMonth(list, ym, day), `a comparison on ${day}`).not.toBeNull()
      expect(list.some((e) => e.amount < 0) && list.filter((e) => e.source === 'ai').length >= 2 && list.filter((e) => paidInAnother(e, 'CAD')).length >= 4, `a refund, AI rows and USD rows on ${day}`).toBe(true)
      expect(made.bets.every((b) => String(b.date) <= day)).toBe(true)
    }
  })
})

describe('loadSampleData', () => {
  beforeEach(() => localStorage.clear())

  it('replaces what the demo held, on its server and on this device, and leaves the device’s own settings alone', () => {
    const uid = DEMO_USER.id
    localStorage.setItem('demo:rows', JSON.stringify([{ id: 'old-bet' }]))
    localStorage.setItem('demo:expenses', JSON.stringify([{ id: 'old-expense' }]))
    localStorage.setItem('demo:tombstones', JSON.stringify({ 'rows:x': '2026-01-01T00:00:00.000Z' }))
    localStorage.setItem('demo:signed-out', '1')
    localStorage.setItem(`bettracker:cache:${uid}`, JSON.stringify([{ id: 'old-bet' }]))
    localStorage.setItem(`bettracker:outbox:${uid}`, JSON.stringify([{ kind: 'add' }]))
    localStorage.setItem(`bettracker:expenses:${uid}`, JSON.stringify([{ id: 'old-expense' }]))
    const kept = ['bettracker:theme', 'bettracker:lang', 'bettracker:view', 'bettracker:fx']
    for (const k of kept) localStorage.setItem(k, 'kept')

    loadSampleData('es', NOW)

    const stored = (name: string): unknown => JSON.parse(localStorage.getItem(`demo:${name}`) ?? 'null')
    const made = sampleData(NOW, { userId: uid, lang: 'es' })
    expect(stored('rows')).toEqual(made.bets)
    expect(stored('moves')).toEqual(made.moves)
    expect(stored('settings')).toEqual(made.settings)
    expect(stored('expense-cards')).toEqual(made.cards)
    expect(stored('expenses')).toEqual(made.expenses)
    expect(stored('expense-budgets')).toEqual(made.budgets)
    // Signed in again, no trace of what was deleted before, and nothing of the old copy on the device.
    expect(localStorage.getItem('demo:signed-out')).toBeNull()
    expect(localStorage.getItem('demo:tombstones')).toBeNull()
    for (const k of [`bettracker:cache:${uid}`, `bettracker:outbox:${uid}`, `bettracker:expenses:${uid}`]) expect(localStorage.getItem(k), k).toBeNull()
    for (const k of kept) expect(localStorage.getItem(k), k).toBe('kept')
    expect(demoHasData()).toBe(true)
  })
})
