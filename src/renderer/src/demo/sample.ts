import type { ExpenseCategory } from '../../../shared/types'
import { addDays, addMonths, toDateStr, weekdayOf, type MonthKey } from '../lib/dates'
import { convert } from '../lib/fx'
import { budgetId, stableUuid } from '../lib/stableId'
import { DEMO_PREFIX, DEMO_USER, resetDemo } from './demo'

/**
 * Sample data for the demo: two months of a made-up person's bets and
 * everyday expenses, so the app can be looked at full before any real data
 * goes into it. Demo only: nothing here is in the real app's bundle.
 *
 * It is the same every time. The bets are drawn from a seeded generator and
 * the expenses from two written months (this one and the last), and only the
 * dates move: everything is placed relative to today, and nothing is dated
 * after it. The rows are written as the database holds them (snake_case), so
 * the app loads them from the demo's server like any others.
 *
 * The person lives in Canada: the expense currency is CAD, and a few things
 * were paid in US dollars (a subscription billed in USD, a weekend away), each
 * with what was paid, its currency and the rate it was converted at.
 */

type Row = Record<string, unknown>

export interface SampleData {
  /** The user_settings row. */
  settings: Row
  /** The bets (table `entries`). */
  bets: Row[]
  /** Deposits and withdrawals (table `bankroll_moves`). */
  moves: Row[]
  cards: Row[]
  expenses: Row[]
  budgets: Row[]
}

export interface SampleOptions {
  userId: string
  /** The language of the few words that are not names: some notes, and football's tag. */
  lang: 'en' | 'es'
}

/** A small seeded generator (mulberry32): the same numbers on every device. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100
const pad = (n: number): string => String(n).padStart(2, '0')
const localDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

// ---- bets ----

const BOOKS = ['bet365', 'bet365', 'DraftKings', 'DraftKings', 'FanDuel', 'BetMGM'] as const
const STAKES = [10, 20, 20, 25, 25, 25, 40, 50] as const
type BetType = 'Moneyline' | 'Spread' | 'Total' | 'Parlay'
const BET_TYPES: readonly BetType[] = ['Moneyline', 'Moneyline', 'Moneyline', 'Spread', 'Spread', 'Spread', 'Total', 'Total', 'Parlay']
type Sport = 'NBA' | 'NFL' | 'NHL' | 'Soccer'
/** The sports there are games of on each weekday (0 = Sunday): football on Sundays, Mondays and Thursdays. */
const SPORTS_BY_WEEKDAY: readonly (readonly Sport[])[] = [
  ['NFL', 'NFL', 'NFL', 'NBA', 'NHL', 'Soccer'],
  ['NFL', 'NBA', 'NBA', 'NHL', 'NHL', 'NBA'],
  ['NBA', 'NBA', 'NHL', 'NHL', 'Soccer', 'Soccer'],
  ['NBA', 'NBA', 'NHL', 'NHL', 'Soccer', 'Soccer'],
  ['NFL', 'NFL', 'NBA', 'NHL', 'NBA', 'Soccer'],
  ['NBA', 'NBA', 'NHL', 'NHL', 'NBA', 'Soccer'],
  ['NHL', 'NHL', 'NBA', 'Soccer', 'Soccer', 'Soccer']
]
const TEAMS: Record<Sport, readonly string[]> = {
  NBA: ['Raptors', 'Celtics', 'Knicks', 'Nuggets', 'Bucks', 'Thunder'],
  NFL: ['Bills', 'Chiefs', 'Eagles', 'Lions', 'Ravens', '49ers'],
  NHL: ['Leafs', 'Canadiens', 'Oilers', 'Canucks', 'Jets', 'Senators'],
  Soccer: ['Real Madrid', 'Barcelona', 'Arsenal', 'Liverpool', 'Inter', 'Bayern']
}
/** A spread and a total as each sport writes them. */
const LINES: Record<Sport, { spreads: readonly string[]; totals: readonly string[] }> = {
  NBA: { spreads: ['-3.5', '+4.5', '-6.5', '+2.5'], totals: ['Over 221.5', 'Under 228.5', 'Over 216.5'] },
  NFL: { spreads: ['-3', '+3.5', '-6.5', '+7'], totals: ['Over 44.5', 'Under 47.5', 'Over 41.5'] },
  NHL: { spreads: ['-1.5', '+1.5'], totals: ['Over 5.5', 'Under 6.5', 'Over 6'] },
  Soccer: { spreads: ['-1', '+0.5', '-0.5'], totals: ['Over 2.5', 'Under 2.5', 'Over 3'] }
}

/** The generator's seed: change it and every bet changes. */
const BET_SEED = 23
const SETTLED_BETS = 56
/** How far back the bets go, in days. */
const BET_DAYS = 58
/** Still open: three placed today and one yesterday. */
const PENDING_DAYS_AGO = [1, 0, 0, 0] as const

// ---- expenses ----

type Pay = 'visa' | 'amex' | null
type NoteKey = 'concert' | 'returned' | 'withAna' | 'flight' | 'weekend' | 'phone' | 'internet'
const NOTES: Record<NoteKey, { en: string; es: string }> = {
  concert: { en: 'concert tickets', es: 'entradas del concierto' },
  returned: { en: 'returned one item', es: 'devolví un artículo' },
  withAna: { en: 'dinner with Ana', es: 'cena con Ana' },
  flight: { en: 'flight to New York', es: 'vuelo a Nueva York' },
  weekend: { en: 'weekend in New York', es: 'fin de semana en Nueva York' },
  phone: { en: 'phone', es: 'teléfono' },
  internet: { en: 'internet', es: 'internet' }
}

interface Line {
  /** Day of the month, 1 to 28 (every month has it). */
  day: number
  merchant: string
  category: ExpenseCategory
  /** In CAD; or, with `usd`, in US dollars. Negative: a refund. */
  amount: number
  card: Pay
  /** Paid in US dollars at this rate (CAD per USD). */
  usd?: number
  note?: NoteKey
  /** Read from a picture by AI. */
  ai?: true
}

/**
 * The month under way. Its first day already has the subscriptions (a budget
 * near its limit from then on) and the concert tickets (a budget over its
 * limit), so both show whatever day the sample is loaded on.
 */
const THIS_MONTH: readonly Line[] = [
  { day: 1, merchant: 'Netflix', category: 'subscriptions', amount: 20.99, card: 'visa' },
  { day: 1, merchant: 'Spotify', category: 'subscriptions', amount: 12.69, card: 'visa' },
  { day: 1, merchant: 'Dropbox', category: 'subscriptions', amount: 11.99, card: 'visa', usd: 1.4034 },
  { day: 1, merchant: 'Ticketmaster', category: 'entertainment', amount: 124.5, card: 'visa', note: 'concert' },
  { day: 2, merchant: 'Tim Hortons', category: 'coffee', amount: 4.87, card: 'amex' },
  { day: 3, merchant: 'Metro', category: 'groceries', amount: 86.42, card: 'amex' },
  { day: 4, merchant: 'Bell', category: 'home', amount: 68.99, card: 'visa', note: 'phone' },
  { day: 5, merchant: 'Sushi Shop', category: 'food', amount: 27.8, card: 'amex' },
  { day: 6, merchant: 'Petro-Canada', category: 'transport', amount: 58.12, card: 'visa', ai: true },
  { day: 8, merchant: 'Amazon.ca', category: 'shopping', amount: 42.99, card: 'visa' },
  { day: 9, merchant: 'Starbucks', category: 'coffee', amount: 6.45, card: null },
  { day: 10, merchant: 'Hydro-Québec', category: 'home', amount: 91.37, card: 'visa' },
  { day: 11, merchant: 'Amazon.ca', category: 'shopping', amount: -34.99, card: 'visa', note: 'returned' },
  { day: 12, merchant: 'Patreon', category: 'subscriptions', amount: 5, card: 'visa', usd: 1.3987 },
  { day: 12, merchant: 'Tacos Frida', category: 'food', amount: 38.6, card: 'amex', note: 'withAna' },
  { day: 14, merchant: 'Costco', category: 'groceries', amount: 164.33, card: 'visa' },
  { day: 16, merchant: 'Cineplex', category: 'entertainment', amount: 31, card: 'amex' },
  { day: 17, merchant: 'Uber Eats', category: 'food', amount: 33.45, card: 'visa' },
  { day: 18, merchant: 'Tim Hortons', category: 'coffee', amount: 5.12, card: 'amex' },
  { day: 18, merchant: 'IGA', category: 'groceries', amount: 48.96, card: 'amex', ai: true },
  { day: 19, merchant: 'Steam', category: 'entertainment', amount: 14.99, card: 'visa', usd: 1.4051 },
  { day: 20, merchant: 'Shoppers Drug Mart', category: 'health', amount: 23.47, card: 'amex' },
  { day: 21, merchant: 'Uber', category: 'transport', amount: 22.1, card: 'visa' },
  { day: 22, merchant: 'Metro', category: 'groceries', amount: 93.05, card: 'amex' },
  { day: 23, merchant: 'Starbucks', category: 'coffee', amount: 6.45, card: 'amex' },
  { day: 24, merchant: 'Vidéotron', category: 'home', amount: 65, card: 'visa', note: 'internet' },
  { day: 25, merchant: 'Pizzeria Napoletana', category: 'food', amount: 44, card: 'amex' },
  { day: 26, merchant: 'Presto', category: 'transport', amount: 40, card: 'visa' },
  { day: 27, merchant: 'Winners', category: 'shopping', amount: 64.8, card: 'visa' },
  { day: 28, merchant: 'Tim Hortons', category: 'coffee', amount: 4.87, card: null }
]

/** The month before, whole: the same bills, and a weekend in New York paid in US dollars. */
const LAST_MONTH: readonly Line[] = [
  { day: 1, merchant: 'Netflix', category: 'subscriptions', amount: 20.99, card: 'visa' },
  { day: 1, merchant: 'Spotify', category: 'subscriptions', amount: 12.69, card: 'visa' },
  { day: 1, merchant: 'Dropbox', category: 'subscriptions', amount: 11.99, card: 'visa', usd: 1.3895 },
  { day: 2, merchant: 'Metro', category: 'groceries', amount: 78.64, card: 'amex' },
  { day: 3, merchant: 'Tim Hortons', category: 'coffee', amount: 4.87, card: 'amex' },
  { day: 4, merchant: 'Bell', category: 'home', amount: 68.99, card: 'visa', note: 'phone' },
  { day: 6, merchant: 'Uber', category: 'transport', amount: 16.45, card: 'visa' },
  { day: 7, merchant: 'Costco', category: 'groceries', amount: 152.08, card: 'visa' },
  { day: 9, merchant: 'Air Canada', category: 'travel', amount: 284.16, card: 'visa', note: 'flight' },
  { day: 10, merchant: 'Hydro-Québec', category: 'home', amount: 84.12, card: 'visa' },
  { day: 11, merchant: 'Starbucks', category: 'coffee', amount: 5.95, card: 'amex' },
  { day: 12, merchant: 'Sushi Shop', category: 'food', amount: 31.2, card: 'amex' },
  { day: 13, merchant: 'Canada Post', category: 'other', amount: 18.42, card: 'amex' },
  { day: 14, merchant: 'Canadian Tire', category: 'shopping', amount: 47.35, card: 'visa' },
  { day: 16, merchant: 'Airbnb', category: 'travel', amount: 186.4, card: 'visa', usd: 1.3962, note: 'weekend' },
  { day: 17, merchant: 'Shake Shack', category: 'food', amount: 18.75, card: 'visa', usd: 1.3978, ai: true },
  { day: 17, merchant: 'MoMA', category: 'entertainment', amount: 30, card: 'visa', usd: 1.3978, ai: true },
  { day: 18, merchant: 'Uber', category: 'transport', amount: 23.4, card: 'visa', usd: 1.4012 },
  { day: 19, merchant: 'Winners', category: 'shopping', amount: 59.99, card: 'visa' },
  { day: 20, merchant: 'Winners', category: 'shopping', amount: -25, card: 'visa', note: 'returned' },
  { day: 21, merchant: 'IGA', category: 'groceries', amount: 61.73, card: 'amex' },
  { day: 22, merchant: 'Shoppers Drug Mart', category: 'health', amount: 18.29, card: 'amex' },
  { day: 23, merchant: 'Cineplex', category: 'entertainment', amount: 28.5, card: 'amex' },
  { day: 24, merchant: 'Vidéotron', category: 'home', amount: 65, card: 'visa', note: 'internet' },
  { day: 25, merchant: 'Petro-Canada', category: 'transport', amount: 54.6, card: 'visa' },
  { day: 26, merchant: 'Tacos Frida', category: 'food', amount: 42.1, card: 'amex', note: 'withAna' },
  { day: 27, merchant: 'Tim Hortons', category: 'coffee', amount: 3.42, card: null },
  { day: 28, merchant: 'Metro', category: 'groceries', amount: 88.9, card: 'amex' }
]

/** The monthly budgets: the subscriptions end the month just under theirs, and the concert tickets alone are past the other. */
const BUDGETS = { total: 1500, visa: 1000, subscriptions: 60, entertainment: 100 } as const

/**
 * The sample as of `now`: the same rows whenever it is made, with their dates
 * counted back from today (the local day of `now`). Nothing is dated or
 * stamped after `now`: a row stamped in the future would win every conflict
 * against the edits made to it (data/bets.ts).
 */
export function sampleData(now: Date, o: SampleOptions): SampleData {
  const today = localDate(now)
  const user_id = o.userId
  const latest = now.getTime() - 60_000
  /** A moment of that local day (minutes after midnight), never after `latest`. */
  const at = (date: string, minutes: number): string => {
    const [y, m, d] = date.split('-').map(Number)
    return new Date(Math.min(new Date(y, m - 1, d, 0, minutes).getTime(), latest)).toISOString()
  }
  const id = (what: string): string => stableUuid(`demo-sample|${what}`)

  // ---- the bets ----
  const rand = seeded(BET_SEED)
  const daysAgo: number[] = []
  for (let i = 0; i < SETTLED_BETS; i++) daysAgo.push(1 + Math.floor(rand() * BET_DAYS))
  daysAgo.sort((a, b) => b - a)
  daysAgo.push(...PENDING_DAYS_AGO)
  const bets: Row[] = daysAgo.map((ago, i) => {
    const pending = i >= SETTLED_BETS
    const date = addDays(today, -ago)
    // The same number of draws for every bet, so one bet's choices never shift the next one's.
    const [rSport, rType, rBook, rStake, rOdds, rTeam, rLine, rClose, rCloseBy, rResult, rNote] = Array.from({ length: 11 }, rand)
    const from = <T>(list: readonly T[], r: number): T => list[Math.floor(r * list.length)]
    const sport = from(SPORTS_BY_WEEKDAY[weekdayOf(date)], rSport)
    const betType = from(BET_TYPES, rType)
    const odds = round2(betType === 'Parlay' ? 3.4 + rOdds * 3.2 : betType === 'Moneyline' ? 1.5 + rOdds * 1.3 : 1.87 + rOdds * 0.08)
    const stake = betType === 'Parlay' ? 10 : from(STAKES, rStake)
    // Most settled prices are checked against the close; a careful bettor beats it a little more often than not.
    const closingOdds = !pending && betType !== 'Parlay' && rClose < 0.6 ? Math.max(1.05, round2(odds - 0.07 + rCloseBy * 0.11)) : null
    const team = from(TEAMS[sport], rTeam)
    const note =
      rNote < 0.3
        ? ''
        : betType === 'Moneyline'
          ? `${team} ML`
          : betType === 'Spread'
            ? `${team} ${from(LINES[sport].spreads, rLine)}`
            : betType === 'Total'
              ? from(LINES[sport].totals, rLine)
              : `Parlay x${2 + Math.floor(rLine * 3)}`
    // A fair price wins as often as it says; a spread or a total lands on the number now and then.
    const push = !pending && (betType === 'Spread' || betType === 'Total') && rResult > 0.96
    const won = !pending && !push && rResult < 1 / odds
    const status = pending ? 'pending' : push ? 'push' : won ? 'won' : 'lost'
    const stamp = at(date, 11 * 60 + (i % 9) * 37)
    return {
      id: id(`bet|${i}`),
      user_id,
      date,
      amount: pending ? null : push ? 0 : won ? round2(stake * (odds - 1)) : -stake,
      stake,
      odds,
      closing_odds: closingOdds,
      status,
      note,
      // A tag is the user's own word for it: football's, in their language.
      sport: sport === 'Soccer' && o.lang === 'es' ? 'Fútbol' : sport,
      book: from(BOOKS, rBook),
      bet_type: betType,
      created_at: stamp,
      updated_at: stamp
    }
  })

  // ---- the bankroll ----
  const settingsAt = at(addDays(today, -BET_DAYS - 2), 9 * 60)
  const settings: Row = {
    user_id,
    odds_format: 'american',
    unit_size: null,
    show_units: false,
    starting_bankroll: 500,
    default_stake: null,
    loss_limit: null,
    expense_currency: 'CAD',
    updated_at: settingsAt
  }
  const depositDay = addDays(today, -31)
  const moves: Row[] = [{ id: id('move|0'), user_id, date: depositDay, amount: 250, note: 'Interac e-Transfer', created_at: at(depositDay, 10 * 60), updated_at: at(depositDay, 10 * 60) }]

  // ---- the cards, the expenses and the budgets ----
  const cardsAt = [at(addDays(today, -70), 9 * 60), at(addDays(today, -70), 9 * 60 + 5)]
  const visa = id('card|visa')
  const amex = id('card|amex')
  const cards: Row[] = [
    { id: visa, user_id, name: 'Visa TD', last4: '4821', kind: 'credit', archived: false, created_at: cardsAt[0], updated_at: cardsAt[0] },
    { id: amex, user_id, name: 'Amex Cobalt', last4: '1007', kind: 'credit', archived: false, created_at: cardsAt[1], updated_at: cardsAt[1] }
  ]
  const [year, month, dayOfMonth] = today.split('-').map(Number)
  const thisMonth: MonthKey = { year, month: month - 1 }
  const monthRows = (ym: MonthKey, lines: readonly Line[], name: string, throughDay: number): Row[] =>
    lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => line.day <= throughDay)
      .map(({ line, i }) => {
        const date = toDateStr(ym.year, ym.month, line.day)
        const stamp = at(date, 8 * 60 + 30 + (i % 7) * 95)
        return {
          id: id(`expense|${name}|${i}`),
          user_id,
          date,
          amount: line.usd === undefined ? line.amount : convert(line.amount, line.usd, 2),
          original_amount: line.usd === undefined ? null : line.amount,
          original_currency: line.usd === undefined ? null : 'USD',
          fx_rate: line.usd ?? null,
          card_id: line.card === 'visa' ? visa : line.card === 'amex' ? amex : null,
          merchant: line.merchant,
          category: line.category,
          note: line.note ? NOTES[line.note][o.lang] : '',
          source: line.ai ? 'ai' : 'manual',
          created_at: stamp,
          updated_at: stamp
        }
      })
  const expenses = [...monthRows(addMonths(thisMonth, -1), LAST_MONTH, 'last', 31), ...monthRows(thisMonth, THIS_MONTH, 'this', dayOfMonth)]
  const budgetsAt = at(addDays(today, -62), 9 * 60 + 20)
  const budget = (scope: 'total' | 'card' | 'category', target: string, monthly_limit: number): Row => ({
    id: budgetId(user_id, scope, target),
    user_id,
    scope,
    target,
    monthly_limit,
    created_at: budgetsAt,
    updated_at: budgetsAt
  })
  const budgets: Row[] = [
    budget('total', '', BUDGETS.total),
    budget('card', visa, BUDGETS.visa),
    budget('category', 'subscriptions', BUDGETS.subscriptions),
    budget('category', 'entertainment', BUDGETS.entertainment)
  ]

  return { settings, bets, moves, cards, expenses, budgets }
}

/**
 * Replaces everything in the demo with the sample: the fake server's tables
 * are written whole and this device's copy is cleared, so the next load reads
 * the sample from the server as any device would. The caller reloads.
 */
export function loadSampleData(lang: 'en' | 'es', now: Date = new Date()): void {
  resetDemo()
  const s = sampleData(now, { userId: DEMO_USER.id, lang })
  const put = (name: string, value: unknown): void => localStorage.setItem(DEMO_PREFIX + name, JSON.stringify(value))
  put('settings', s.settings)
  put('rows', s.bets)
  put('moves', s.moves)
  put('expense-cards', s.cards)
  put('expenses', s.expenses)
  put('expense-budgets', s.budgets)
}
