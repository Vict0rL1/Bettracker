import type { ExpenseInput } from '../../../shared/types'
import type { Problem } from './betForm'
import { currencyDigits } from './currency'
import { formatAmountText, parseAmountText } from './expenseForm'
import { convert, isRate, rateFrom, rateText, roundRate } from './fx'
import { MAX_AMOUNT } from './validate'

/**
 * An expense paid in another currency, as the sheet and the scan review show
 * it: the rate and the amount in the main currency, each a box the user can
 * type in. The two always agree with the amount paid: typing the rate works
 * out the converted amount, typing the converted amount (what the bank
 * statement says) works out the rate. Only the box the user typed in is kept
 * as text (`FxTyped`); the other is worked out from it every time, so the two
 * can never drift.
 *
 * Where no box was typed in, the rate is the one saved with the expense being
 * edited (`stored`) or the one fetched for its date (`auto`); with none of
 * those there is no rate, the boxes are empty, and the expense can't be saved
 * until one is typed: an amount in dollars is never saved as if it were the
 * main currency.
 */

/** What the user typed in one of the two boxes. The other follows it. */
export interface FxTyped {
  lead: 'rate' | 'converted'
  text: string
}

/** A rate from the service or this device's cache, and the day it is of. */
export interface FxAuto {
  rate: number
  asOf: string
  source: 'service' | 'cache' | 'last'
}

/** The rate and amount saved with the expense being edited. */
export interface FxStored {
  rate: number
  /** Unsigned, in the main currency. */
  converted: number
  /** Unsigned: what was paid when it was saved (the converted amount is kept as saved while this is untouched). */
  original: number
}

/**
 * Where the rate on screen comes from: the service's rate of a day, this
 * device's last one of the pair (the service couldn't be reached), the user
 * (in this box, or in the review's box for every row without one), or the
 * expense as it was saved.
 */
export type RateOrigin = { how: 'service' | 'cache' | 'last'; asOf: string } | { how: 'typed' } | { how: 'typedAll' } | { how: 'stored' }

export interface FxView {
  /** What each box shows. */
  rateText: string
  convertedText: string
  /** The rate, when there is a usable one. */
  rate: number | null
  /** The amount in the main currency (unsigned, to its minor units), when it can be worked out and is more than 0. */
  converted: number | null
  origin: RateOrigin | null
  /** What keeps this from being saved, by box; both null when rate and converted are there. */
  rateProblem: Problem | null
  convertedProblem: Problem | null
}

/** Decimals a rate is written with in its box at least ("1.4000", and all eight when it has them). */
const RATE_MIN_DECIMALS = 4

/** An amount is stored with two decimals at most, whatever its currency has. */
export const mainDigits = (main: string): number => Math.min(2, currencyDigits(main))

/**
 * A rate as typed: "1.4034", "1,4034" (a comma is a decimal comma here, never
 * thousands: "1,403" is 1.403), "4,000.50" or "4.000,50" (both kinds: the
 * last one is the decimal). '' → null; anything that is no rate above 0 →
 * 'invalid'.
 */
export function parseRateText(text: string): number | null | 'invalid' {
  const s = text.trim().replace(/\s+/g, '')
  if (s === '') return null
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return 'invalid'
  const dots = s.split('.').length - 1
  const commas = s.split(',').length - 1
  let plain: string
  if (dots > 0 && commas > 0) {
    const decimal = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ','
    if (s.indexOf(decimal) !== s.lastIndexOf(decimal)) return 'invalid'
    const [whole, fraction] = s.split(decimal)
    if (!whole.split(decimal === '.' ? ',' : '.').every((g, i) => (i === 0 ? /^\d{1,3}$/.test(g) : /^\d{3}$/.test(g)))) return 'invalid'
    plain = `${whole.replace(/[.,]/g, '')}.${fraction}`
  } else if (dots + commas > 1) {
    return 'invalid'
  } else {
    plain = s.replace(',', '.')
  }
  const n = Number(plain === '.' ? 'x' : plain)
  if (!Number.isFinite(n)) return 'invalid'
  const rate = roundRate(n)
  return isRate(rate) ? rate : 'invalid'
}

/** A rate as box text: at least four decimals, all it has up to eight. */
export const rateBoxText = (rate: number): string => rateText(rate, RATE_MIN_DECIMALS)

const NONE: FxView = { rateText: '', convertedText: '', rate: null, converted: null, origin: null, rateProblem: null, convertedProblem: null }

/** A converted amount judged as stored: more than 0 to the cent, within range. */
function convertedIssue(converted: number): Problem | null {
  if (converted > MAX_AMOUNT) return { key: 'field.tooBig' }
  if (Math.round(converted * 100) === 0) return { key: 'field.convertedZero' }
  return null
}

/**
 * The two boxes and what they come to, for an amount paid in another
 * currency. `amount` is that amount as read from its box (unsigned), or null
 * when the box holds no usable number yet. In order: what the user typed;
 * else the rate saved with the expense; else the fetched one; else (the
 * review only) the rate typed for every row without one; else nothing.
 */
export function fxView(o: { typed: FxTyped | null; stored?: FxStored | null; auto?: FxAuto | null; all?: number | null; amount: number | null; main: string }): FxView {
  const digits = mainDigits(o.main)
  const amount = o.amount !== null && Number.isFinite(o.amount) && Math.round(o.amount * 100) > 0 ? o.amount : null
  const required: Problem = { key: 'field.rateRequired', vars: { currency: o.main } }

  /** From a rate: the converted amount follows the amount paid. */
  const fromRate = (rate: number, shown: string, origin: RateOrigin, keep?: number): FxView => {
    const converted = keep ?? (amount === null ? null : convert(amount, rate, digits))
    const issue = converted === null ? null : convertedIssue(converted)
    return {
      rateText: shown,
      convertedText: converted === null ? '' : formatAmountText(converted, o.main),
      rate,
      converted: converted === null || issue ? null : converted,
      origin,
      rateProblem: null,
      convertedProblem: issue
    }
  }

  if (o.typed && o.typed.lead === 'rate') {
    const rate = parseRateText(o.typed.text)
    // Emptied while it has focus: both boxes empty until something is typed (or the box is left).
    if (rate === null) return { ...NONE, rateProblem: required }
    if (rate === 'invalid') return { ...NONE, rateText: o.typed.text, origin: { how: 'typed' }, rateProblem: { key: 'field.rateInvalid' } }
    return fromRate(rate, o.typed.text, { how: 'typed' })
  }

  if (o.typed) {
    const n = parseAmountText(o.typed.text, currencyDigits(o.main))
    const base = { ...NONE, convertedText: o.typed.text, origin: { how: 'typed' } as RateOrigin }
    if (n === null) return { ...NONE, rateProblem: required }
    if (n === 'invalid') return { ...base, convertedProblem: { key: 'field.resultInvalid' } }
    if (n === 'noMinorUnits') return { ...base, convertedProblem: { key: 'field.noMinorUnits', vars: { currency: o.main } } }
    const issue = convertedIssue(n)
    if (issue) return { ...base, convertedProblem: issue.key === 'field.convertedZero' && !/[1-9]/.test(o.typed.text) ? { key: 'field.convertedRequired', vars: { currency: o.main } } : issue }
    // The rate behind what the bank charged. Without the amount paid there is none yet (the amount box says so).
    const rate = amount === null ? null : rateFrom(amount, n)
    if (rate !== null && !isRate(rate)) return { ...base, convertedProblem: { key: 'field.rateInvalid' } }
    return { ...base, rateText: rate === null ? '' : rateBoxText(rate), rate, converted: n }
  }

  if (o.stored) {
    // Untouched, the amount saved stands (it may be what the bank charged, not original × rate).
    const untouched = amount !== null && Math.round(amount * 100) === Math.round(o.stored.original * 100)
    return fromRate(o.stored.rate, rateBoxText(o.stored.rate), { how: 'stored' }, untouched ? o.stored.converted : undefined)
  }
  if (o.auto) return fromRate(o.auto.rate, rateBoxText(o.auto.rate), { how: o.auto.source, asOf: o.auto.asOf })
  if (o.all !== null && o.all !== undefined) return fromRate(o.all, rateBoxText(o.all), { how: 'typedAll' })
  return { ...NONE, rateProblem: required }
}

/**
 * What is left of what the user typed once they leave the box: a box left
 * empty is no longer typed in (the saved or fetched rate comes back). While
 * the box has focus an empty one stays empty, so it can be typed in afresh.
 */
export const settledFx = (typed: FxTyped | null): FxTyped | null => (typed !== null && typed.text.trim() === '' ? null : typed)

/**
 * What is saved of an expense paid in another currency: the amount in the
 * main currency (what every total counts) and, next to it, what was paid, in
 * what, and the rate. `refund` signs both amounts. Call only with a view that
 * has a rate and a converted amount.
 */
export function fxInput(view: FxView, original: number, currency: string, refund: boolean): Pick<ExpenseInput, 'amount' | 'originalAmount' | 'originalCurrency' | 'fxRate'> {
  const sign = refund ? -1 : 1
  return {
    amount: view.converted === null ? Number.NaN : sign * view.converted,
    originalAmount: sign * original,
    originalCurrency: currency,
    fxRate: view.rate === null ? Number.NaN : view.rate
  }
}

/** An expense in the main currency keeps no original. */
export const NO_ORIGINAL: Pick<ExpenseInput, 'originalAmount' | 'originalCurrency' | 'fxRate'> = { originalAmount: null, originalCurrency: null, fxRate: null }
