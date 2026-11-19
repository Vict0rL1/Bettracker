import { EXPENSE_CATEGORIES, type BudgetScope, type Expense, type ExpenseBudget, type ExpenseCard, type ExpenseCategory } from '../../../shared/types'
import { categoryKey, toCategory } from './categories'
import { addMonths, daysInMonth, monthPrefix, toDateStr, type MonthKey } from './dates'
import { NEAR_RATIO } from './lossLimit'
import type { StringKey } from './strings'

/**
 * What the Expenses view shows about a month: totals per card and per
 * category, the pace, the budgets' states and the chart's points. Pure; every
 * sum is made in whole cents, so 0.1 + 0.2 is 0.30 and never 0.30000000000000004.
 * A refund (a negative amount) lowers what was spent.
 */

/** The key a row is totalled and charted under when its card is none, or one this device doesn't know. */
export const NO_CARD = 'none'

/** The key a row is charted and totalled under: its card's id when this device knows the card (archived included), else NO_CARD. */
export function cardKeyOf(e: Expense, known: ReadonlySet<string>): string {
  return e.cardId !== null && known.has(e.cardId) ? e.cardId : NO_CARD
}

const cents = (n: number): number => Math.round(n * 100)
const fromCents = (c: number): number => c / 100

export const expensesInMonth = (list: readonly Expense[], ym: MonthKey): Expense[] => {
  const prefix = `${monthPrefix(ym)}-`
  return list.filter((e) => e.date.startsWith(prefix))
}

export interface MonthSpend {
  /** Net: what was spent less what came back. */
  total: number
  /** The positive amounts only. */
  spent: number
  /** What came back (refunds and credits), as a positive number. */
  refunded: number
  count: number
  /** Net per cardKeyOf key. */
  byCard: Map<string, number>
  /** Net per category. */
  byCategory: Map<ExpenseCategory, number>
}

function addTo<K>(map: Map<K, number>, key: K, c: number): void {
  map.set(key, (map.get(key) ?? 0) + c)
}

function toAmounts<K>(map: Map<K, number>): Map<K, number> {
  return new Map([...map].map(([k, c]) => [k, fromCents(c)]))
}

export function monthSpend(list: readonly Expense[], ym: MonthKey, cards: readonly ExpenseCard[]): MonthSpend {
  const known = new Set(cards.map((c) => c.id))
  let total = 0
  let spent = 0
  let refunded = 0
  let count = 0
  const byCard = new Map<string, number>()
  const byCategory = new Map<ExpenseCategory, number>()
  for (const e of expensesInMonth(list, ym)) {
    const c = cents(e.amount)
    total += c
    if (c > 0) spent += c
    else refunded -= c
    count++
    addTo(byCard, cardKeyOf(e, known), c)
    addTo(byCategory, toCategory(e.category), c)
  }
  return { total: fromCents(total), spent: fromCents(spent), refunded: fromCents(refunded), count, byCard: toAmounts(byCard), byCategory: toAmounts(byCategory) }
}

export interface Pace {
  /** The days the average is over: today's day in the current month, all of a past one, none of a future one. */
  daysCounted: number
  dailyAverage: number | null
  /** Where the month ends at this pace (the current month only). */
  projected: number | null
  state: 'past' | 'current' | 'future'
}

/** current month: days elapsed = today's day, projected = total / elapsed × daysInMonth; past: all days, no projection; future: nulls. */
export function pace(total: number, ym: MonthKey, today: string): Pace {
  const [ty, tm, td] = today.split('-').map(Number)
  const order = ym.year * 12 + ym.month - (ty * 12 + (tm - 1))
  const days = daysInMonth(ym)
  if (order > 0) return { daysCounted: 0, dailyAverage: null, projected: null, state: 'future' }
  if (order < 0) return { daysCounted: days, dailyAverage: fromCents(Math.round(cents(total) / days)), projected: null, state: 'past' }
  return {
    daysCounted: td,
    dailyAverage: fromCents(Math.round(cents(total) / td)),
    projected: fromCents(Math.round((cents(total) / td) * days)),
    state: 'current'
  }
}

export interface MonthComparison {
  /** The month before the shown one. */
  previousMonth: MonthKey
  /**
   * The current month: the day both months are counted up to, as a date of the month before (today's day number, or
   * that month's last day when it is shorter). Null for a past month: both months are counted whole.
   */
  previousThrough: string | null
  /** Net spent in the shown month over the days compared. */
  current: number
  /** Net spent in the month before over the same days. */
  previous: number
  /** current − previous: above 0 is more than the month before. */
  diff: number
  /** diff / previous (0.12: 12 % more), or null when the month before spent nothing net by then (no share to speak of). */
  ratio: number | null
}

/**
 * The shown month against the one before it. The current month is compared day for day: both up to today's day
 * number (the 31st against a shorter month's last day), so the 10th is never held against a whole month. A past month
 * is compared whole. Null when there is nothing to compare with: the month before has no expenses at all, or the
 * shown month has not started.
 */
export function vsLastMonth(list: readonly Expense[], ym: MonthKey, today: string): MonthComparison | null {
  const [ty, tm, td] = today.split('-').map(Number)
  const order = ym.year * 12 + ym.month - (ty * 12 + (tm - 1))
  if (order > 0) return null
  const previousMonth = addMonths(ym, -1)
  const before = expensesInMonth(list, previousMonth)
  if (before.length === 0) return null
  /** Each month is counted up to this day number; a month's days never reach 32. */
  const through = order === 0 ? td : 31
  const upTo = (rows: readonly Expense[]): number => rows.reduce((sum, e) => (Number(e.date.slice(8, 10)) <= through ? sum + cents(e.amount) : sum), 0)
  const current = upTo(expensesInMonth(list, ym))
  const previous = upTo(before)
  return {
    previousMonth,
    previousThrough: order === 0 ? toDateStr(previousMonth.year, previousMonth.month, Math.min(td, daysInMonth(previousMonth))) : null,
    current: fromCents(current),
    previous: fromCents(previous),
    diff: fromCents(current - previous),
    ratio: previous > 0 ? (current - previous) / previous : null
  }
}

/** A share is said up to here; past it (ten times the month before) only the amount means anything. */
const MAX_RATIO = 10

/**
 * How a comparison is said: nothing to it ('same', to the cent), or more or less by a whole percentage (0 stands for
 * "under half a percent": something, said as "<1%"), or by the amount alone (`pct` null) when the month before gives
 * no share to speak of: nothing net spent by then, or so little that the percentage would run to thousands.
 */
export type ComparisonChange = { direction: 'same' } | { direction: 'more' | 'less'; pct: number | null }

export function comparisonChange(c: Pick<MonthComparison, 'diff' | 'ratio'>): ComparisonChange {
  if (cents(c.diff) === 0) return { direction: 'same' }
  const direction = c.diff > 0 ? 'more' : 'less'
  if (c.ratio === null || Math.abs(c.ratio) >= MAX_RATIO) return { direction, pct: null }
  return { direction, pct: Math.round(Math.abs(c.ratio) * 100) }
}

export type BudgetLevel = 'none' | 'ok' | 'near' | 'over'

export interface BudgetState {
  level: BudgetLevel
  spent: number
  limit: number | null
  /** limit − spent; below 0 once over. Null without a limit. */
  left: number | null
  /** max(0, spent) / limit; 0 without a limit. */
  ratio: number
}

/** The loss limit's thresholds (lossLimit.ts): near from 80 %, over once past the limit (at the limit is still near). */
export function budgetState(spent: number, limit: number | null): BudgetState {
  if (limit === null || !(limit > 0)) return { level: 'none', spent, limit: null, left: null, ratio: 0 }
  const ratio = Math.max(0, spent) / limit
  const level: BudgetLevel = cents(spent) > cents(limit) ? 'over' : ratio >= NEAR_RATIO ? 'near' : 'ok'
  return { level, spent, limit, left: fromCents(cents(limit) - cents(spent)), ratio }
}

export interface BudgetLine {
  budget: ExpenseBudget
  scope: BudgetScope
  /** A key to translate (the total, a category), or a card's own name. */
  label: { key: StringKey; vars?: Record<string, string> } | { text: string }
  state: BudgetState
}

/** total first, then card budgets in card order (skipping cards this device doesn't know), then categories in EXPENSE_CATEGORIES order. */
export function budgetLines(budgets: readonly ExpenseBudget[], month: MonthSpend, cards: readonly ExpenseCard[]): BudgetLine[] {
  const lines: BudgetLine[] = []
  const total = totalBudget(budgets)
  if (total) lines.push({ budget: total, scope: 'total', label: { key: 'budget.total' }, state: budgetState(month.total, total.monthlyLimit) })
  for (const card of cards) {
    const b = budgets.find((x) => x.scope === 'card' && x.target.toLowerCase() === card.id.toLowerCase())
    if (b) lines.push({ budget: b, scope: 'card', label: { text: card.name }, state: budgetState(month.byCard.get(card.id) ?? 0, b.monthlyLimit) })
  }
  for (const c of EXPENSE_CATEGORIES) {
    const b = budgets.find((x) => x.scope === 'category' && x.target === c)
    if (b) lines.push({ budget: b, scope: 'category', label: { key: categoryKey(c) }, state: budgetState(month.byCategory.get(c) ?? 0, b.monthlyLimit) })
  }
  return lines
}

export const totalBudget = (budgets: readonly ExpenseBudget[]): ExpenseBudget | null => budgets.find((b) => b.scope === 'total') ?? null

export interface CategoryShare {
  category: ExpenseCategory
  amount: number
  /** Of month.spent, 0..1 (a category that only got money back is 0). */
  share: number
}

/** Categories with a non-zero net, largest first (ties: list order). */
export function categoryShares(month: MonthSpend): CategoryShare[] {
  const out: CategoryShare[] = []
  for (const c of EXPENSE_CATEGORIES) {
    const amount = month.byCategory.get(c) ?? 0
    if (amount === 0) continue
    const share = month.spent > 0 ? Math.min(1, Math.max(0, amount / month.spent)) : 0
    out.push({ category: c, amount, share })
  }
  // Array#sort is stable: equal amounts keep the list's order.
  return out.sort((a, b) => b.amount - a.amount)
}

/** name null = "No card"; dashed: drawn as an outline (NO_CARD), so it never needs a fourth grey. */
export interface SpendSeries {
  key: string
  cardId: string | null
  name: string | null
  ink: string
  dashed: boolean
}

/**
 * One day of the chart. `total`: that day's net (every series); `cumulative`:
 * the running total through that day (null where the month has not got to:
 * after today, or a future month). The series keys hold the day's net in the
 * daily view and the running total in the cumulative view.
 */
export interface SpendPoint {
  date: string
  day: number
  total: number
  cumulative: number | null
  [series: string]: number | string | null
}

export const SERIES_INKS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'] as const

const byCreated = (a: ExpenseCard, b: ExpenseCard): number => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const seriesKey = (cardKey: string): string => `s_${cardKey}`

/**
 * Series keys `s_<cardId>` / `s_none`. `daily`: one point per day of the month, each series holding that day's net amount
 * (negative on a day of refunds). `cumulative`: running totals, one point per day **up to today** in the current month
 * (every day of a past month, none of a future one): the chart's x axis is numeric over 1..daysInMonth, so the budget
 * line still spans the month with no null tail inside stacked areas.
 * Series: cards with spending in the month, in card createdAt order, then NO_CARD when present. Inks come from the
 * card's position among ALL cards (stable across months): SERIES_INKS[i % 4]; NO_CARD gets 'var(--series-none)', dashed.
 * `min` is the lowest stacked value of either view (≤ 0: the stacks start at 0, and refunds dip below it), `max` the
 * highest cumulative, `maxDaily` the highest day.
 */
export function spendChartData(
  list: readonly Expense[],
  cards: readonly ExpenseCard[],
  ym: MonthKey,
  today: string
): { series: SpendSeries[]; daily: SpendPoint[]; cumulative: SpendPoint[]; min: number; max: number; maxDaily: number } {
  const ordered = [...cards].sort(byCreated)
  const known = new Set(ordered.map((c) => c.id))
  const days = daysInMonth(ym)
  // Per day (1-based) and per card key, in cents.
  const perDay = new Map<string, number[]>()
  for (const e of expensesInMonth(list, ym)) {
    const k = cardKeyOf(e, known)
    const row = perDay.get(k) ?? new Array<number>(days + 1).fill(0)
    row[Number(e.date.slice(8, 10))] += cents(e.amount)
    perDay.set(k, row)
  }

  const series: SpendSeries[] = []
  ordered.forEach((card, i) => {
    if (perDay.has(card.id)) series.push({ key: seriesKey(card.id), cardId: card.id, name: card.name, ink: SERIES_INKS[i % SERIES_INKS.length], dashed: false })
  })
  if (perDay.has(NO_CARD)) series.push({ key: seriesKey(NO_CARD), cardId: null, name: null, ink: 'var(--series-none)', dashed: true })

  const [ty, tm, td] = today.split('-').map(Number)
  const order = ym.year * 12 + ym.month - (ty * 12 + (tm - 1))
  /** The last day the month has got to: all of a past month, today in the current one, none of a future one. */
  const lastDay = order < 0 ? days : order === 0 ? Math.min(td, days) : 0

  const daily: SpendPoint[] = []
  const cumulative: SpendPoint[] = []
  const running = new Map<string, number>(series.map((s) => [s.key, 0]))
  let runningTotal = 0
  let min = 0
  let max = 0
  let maxDaily = 0
  for (let day = 1; day <= days; day++) {
    const date = toDateStr(ym.year, ym.month, day)
    const reached = day <= lastDay
    const point: SpendPoint = { date, day, total: 0, cumulative: null }
    let dayTotal = 0
    let up = 0
    let down = 0
    for (const s of series) {
      const c = perDay.get(s.cardId ?? NO_CARD)?.[day] ?? 0
      point[s.key] = fromCents(c)
      dayTotal += c
      if (c > 0) up += c
      else down += c
      running.set(s.key, (running.get(s.key) ?? 0) + c)
    }
    runningTotal += dayTotal
    point.total = fromCents(dayTotal)
    point.cumulative = reached ? fromCents(runningTotal) : null
    daily.push(point)
    // Daily bars stack by sign (refunds below 0).
    maxDaily = Math.max(maxDaily, up)
    min = Math.min(min, down)
    if (reached) {
      const at: SpendPoint = { date, day, total: fromCents(dayTotal), cumulative: fromCents(runningTotal) }
      // Cumulative areas stack in series order: each level is a partial sum.
      let level = 0
      for (const s of series) {
        const r = running.get(s.key) ?? 0
        at[s.key] = fromCents(r)
        level += r
        min = Math.min(min, level)
        max = Math.max(max, level)
      }
      cumulative.push(at)
    }
  }
  return { series, daily, cumulative, min: fromCents(min), max: fromCents(max), maxDaily: fromCents(maxDaily) }
}

export interface ExpenseFilter {
  /** A card's id, NO_CARD, or 'all'. */
  card: string | 'all'
  category: ExpenseCategory | 'all'
  query: string
}

/** Lowercase, accents stripped: "Café" finds "cafe" and the other way round. */
const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** card: a card id or NO_CARD; query: accent/case-insensitive on merchant and note. */
export function filterExpenses(list: readonly Expense[], f: ExpenseFilter, known: ReadonlySet<string>): Expense[] {
  const q = fold(f.query.trim())
  return list.filter(
    (e) =>
      (f.card === 'all' || cardKeyOf(e, known) === f.card) &&
      (f.category === 'all' || toCategory(e.category) === f.category) &&
      (q === '' || fold(e.merchant).includes(q) || fold(e.note).includes(q))
  )
}

export interface ExpenseDay {
  date: string
  total: number
  /** Newest first (createdAt). */
  items: Expense[]
}

const newestFirst = (a: Expense, b: Expense): number =>
  a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : a.id > b.id ? -1 : a.id < b.id ? 1 : 0

/**
 * Days newest first, each with its net total and its expenses newest first. `limit` lists only the newest that many
 * expenses (a page of the list, days with none of them left out), but a day's total always counts every expense of
 * that day in `list`: a page that ends inside a day never shows part of its total.
 */
export function groupExpensesByDay(list: readonly Expense[], limit = Infinity): ExpenseDay[] {
  const byDate = new Map<string, Expense[]>()
  for (const e of list) {
    const day = byDate.get(e.date)
    if (day) day.push(e)
    else byDate.set(e.date, [e])
  }
  const days: ExpenseDay[] = []
  let left = limit
  for (const date of [...byDate.keys()].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))) {
    if (left <= 0) break
    const all = (byDate.get(date) ?? []).sort(newestFirst)
    const items = all.length > left ? all.slice(0, left) : all
    left -= items.length
    days.push({ date, total: fromCents(all.reduce((sum, e) => sum + cents(e.amount), 0)), items })
  }
  return days
}

/**
 * The card filter's choices for a month's list (`monthList`): the active cards, any archived one the month uses, and
 * the card chosen, whatever month it was chosen in, so the box always shows what the list is filtered by. `value` is
 * the box's value and the card to filter by: `selected` ('all', NO_CARD or a card's id), or 'all' when it names no
 * card this device knows (deleted since), so the list never filters by a card the box can't show.
 */
export function cardFilterChoices(cards: readonly ExpenseCard[], monthList: readonly Expense[], selected: string): { cards: ExpenseCard[]; value: string } {
  const value = selected === 'all' || selected === NO_CARD || cards.some((c) => c.id === selected) ? selected : 'all'
  const used = new Set(monthList.map((e) => e.cardId))
  return { cards: cards.filter((c) => !c.archived || used.has(c.id) || c.id === value), value }
}

/** The latest first: by date, then by when it was added. */
export const mostRecentFirst = (a: Expense, b: Expense): number => (a.date > b.date ? -1 : a.date < b.date ? 1 : newestFirst(a, b))

/** A merchant as it is compared: the spaces around it and its case aside ("starbucks " is "Starbucks"). */
const merchantKey = (m: string): string => m.trim().toLowerCase()

/** The merchants typed before, each once (whatever its case), most recent first: the sheet's suggestions. */
export function merchantSuggestions(list: readonly Expense[], max = 50): string[] {
  const recent = [...list].sort(mostRecentFirst)
  const seen = new Set<string>()
  const out: string[] = []
  for (const e of recent) {
    const m = e.merchant.trim()
    if (m === '' || seen.has(merchantKey(m))) continue
    seen.add(merchantKey(m))
    out.push(m)
    if (out.length >= max) break
  }
  return out
}

/** How a merchant was last filed: the sheet offers it again (lib/expenseForm.ts followMerchant). */
export interface MerchantLast {
  category: ExpenseCategory
  /** The card's id, or null: paid with no card. */
  cardId: string | null
}

/**
 * The category and card of the most recent expense of exactly this merchant (as merchantSuggestions tells them
 * apart: case and outer spaces aside, "Uber" is not "Uber Eats"), or null for a merchant not typed before, or none.
 */
export function merchantLast(list: readonly Expense[], merchant: string): MerchantLast | null {
  const key = merchantKey(merchant)
  if (key === '') return null
  let latest: Expense | null = null
  for (const e of list) {
    if (merchantKey(e.merchant) === key && (latest === null || mostRecentFirst(e, latest) < 0)) latest = e
  }
  return latest === null ? null : { category: toCategory(latest.category), cardId: latest.cardId }
}
