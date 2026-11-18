/**
 * Exchange rates, the pure part: the request, the reading of the answer, the
 * conversion and the cache's shape. No DOM, no network, and NO IMPORTS: the
 * live contract check (scripts/check-rates.mjs) compiles this one file and
 * runs its parser against the real service, so the check and the app can
 * never read an answer differently (fx.test.ts keeps it import-free).
 *
 * The rates are the European Central Bank's reference rates, served by
 * Frankfurter (https://frankfurter.dev): free, no key, one rate per business
 * day, published around 16:00 CET. A request carries two currency codes and
 * a date, nothing else (data/fxRates.ts makes it).
 *
 *   GET https://api.frankfurter.dev/v1/2026-11-13?base=USD&symbols=CAD
 *   → {"amount":1.0,"base":"USD","date":"2026-11-13","rates":{"CAD":1.4034}}
 *
 * A weekend or holiday answers with the business day before it (the body's
 * `date` says which); `latest` is the newest there is.
 */

export const FX_ORIGIN = 'https://api.frankfurter.dev'

/** A rate as stored and shown: 8 decimals (expenses.fx_rate is numeric(18, 8)). */
export const RATE_DECIMALS = 8

/** More than any real rate, and what the column has room for (ten digits before the point). */
export const MAX_RATE = 1_000_000_000

const CODE = /^[A-Z]{3}$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** An ISO 4217 code as the app stores it: three capital letters. */
export const isCode = (v: unknown): v is string => typeof v === 'string' && CODE.test(v)

/** A calendar date, YYYY-MM-DD, that exists (2026-02-30 doesn't). */
export function isDate(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const m = DATE.exec(v)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = new Date(Date.UTC(y, mo - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}

/** A date as the milliseconds of its UTC midnight. */
const utc = (date: string): number => {
  const [y, m, d] = date.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

/**
 * The day whose rate a date stands for: itself when it is in the past, and
 * today for today or any later day (a rate for tomorrow does not exist; the
 * newest one is the best there is).
 */
export const rateDay = (date: string, today: string): string => (date >= today ? today : date)

/**
 * The request for the rate of 1 `from` in `to` on `date`: `latest` for today
 * or later, the date itself for a past day. Null when a code or a date is not
 * one (nothing is ever sent that isn't two currency codes and a date).
 */
export function rateUrl(from: string, to: string, date: string, today: string): string | null {
  if (!isCode(from) || !isCode(to) || !isDate(date) || !isDate(today)) return null
  return `${FX_ORIGIN}/v1/${date >= today ? 'latest' : date}?base=${from}&symbols=${to}`
}

/** A rate rounded to the decimals it is stored with. */
export function roundRate(rate: number): number {
  const f = 10 ** RATE_DECIMALS
  return Math.round(Number((rate * f).toPrecision(15))) / f
}

/** A rate the app can store: finite, more than 0 once rounded, within the column's room. */
export const isRate = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && roundRate(v) > 0 && v <= MAX_RATE

export interface ProviderRate {
  /** Units of `to` per 1 unit of `from`, rounded to 8 decimals. */
  rate: number
  /** The business day the rate is of (the answer's `date`). */
  asOf: string
}

/**
 * What the service answered, checked: an object naming `from` as its base,
 * with a real date and a rate for `to` that is a finite number above 0. The
 * rates are for `amount` units of the base (1 unless asked otherwise): read
 * per unit. Anything else (another shape, another base, a rate as text, 0, a
 * negative, no date) is null: the app then has no rate, and never a wrong one.
 */
export function parseRateBody(body: unknown, from: string, to: string): ProviderRate | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  if (!isCode(from) || !isCode(to) || b.base !== from) return null
  if (!isDate(b.date)) return null
  const amount = b.amount === undefined ? 1 : b.amount
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return null
  if (typeof b.rates !== 'object' || b.rates === null || Array.isArray(b.rates)) return null
  if (!Object.prototype.hasOwnProperty.call(b.rates, to)) return null
  const raw = (b.rates as Record<string, unknown>)[to]
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null
  const rate = roundRate(raw / amount)
  return isRate(rate) ? { rate, asOf: b.date } : null
}

/** A money amount as a whole number of hundredths (amounts are stored with two decimals). */
const hundredths = (n: number): bigint => BigInt(Math.round(Number((Math.abs(n) * 100).toPrecision(15))))

/**
 * `original` (in the currency paid) at `rate`, in the main currency, rounded
 * half up to that currency's minor units (`digits`: 2 for most, 0 for pesos
 * and yen; never more than 2, which is what an amount is stored with). Done
 * in whole numbers (hundredths × the rate's 8 decimals), so 12.00 × 1.4034 is
 * 16.84 and nothing like 16.840799999999998 is ever rounded the wrong way.
 * The sign follows the original (a refund stays a refund). NaN when an input
 * is not a number the app works with.
 */
export function convert(original: number, rate: number, digits: number): number {
  if (!Number.isFinite(original) || !Number.isFinite(rate) || rate < 0 || !Number.isInteger(digits)) return Number.NaN
  const d = Math.min(2, Math.max(0, digits))
  // hundredths (1e-2) × rate (1e-8) = units of 1e-10; to `d` decimals: ÷ 10^(10 − d), half up.
  const product = hundredths(original) * BigInt(Math.round(Number((rate * 1e8).toPrecision(15))))
  const scale = 10n ** BigInt(10 - d)
  const rounded = (product + scale / 2n) / scale
  const value = Number(rounded) / 10 ** d
  return original < 0 && value !== 0 ? -value : value
}

/**
 * The rate that turns `original` into `converted` (what the bank charged, in
 * the main currency), to 8 decimals: converted ÷ original. Null when there is
 * no original to divide by or a number is not one. Signs are left out: a
 * refund has the same rate as a purchase.
 */
export function rateFrom(original: number, converted: number): number | null {
  if (!Number.isFinite(original) || !Number.isFinite(converted)) return null
  const o = hundredths(original)
  const c = hundredths(converted)
  if (o === 0n) return null
  const scaled = (c * 10n ** BigInt(RATE_DECIMALS) + o / 2n) / o
  return Number(scaled) / 10 ** RATE_DECIMALS
}

/** A rate as text for a box or a line: its decimals without the zeros that say nothing, at least `min` of them ("1.4034", "0.00034123", "1.40"). */
export function rateText(rate: number, min = 0): string {
  const [whole, fraction = ''] = rate.toFixed(RATE_DECIMALS).split('.')
  const kept = fraction.replace(/0+$/, '').padEnd(min, '0')
  return kept === '' ? whole : `${whole}.${kept}`
}

// ---- the cache ----

/** One rate this device has fetched. */
export interface CachedRate {
  rate: number
  /** The business day the rate is of. */
  asOf: string
  /** When it was fetched (ms since the epoch). */
  at: number
}

/**
 * The rates this device has fetched, by pair and day asked for
 * ("USD>CAD@2026-11-13"). Not personal and not per user: two currency codes,
 * a date and a number. Expendable (it is fetched again), and capped.
 */
export interface FxCache {
  v: 1
  rates: Record<string, CachedRate>
}

export const FX_CACHE_VERSION = 1
/** The most rates kept: a few hundred small entries, a few tens of kilobytes. */
export const FX_CACHE_MAX = 300
/** How long a rate that may still be replaced is used before the service is asked again. */
export const FX_FRESH_MS = 6 * 60 * 60 * 1000
/** After this long past a day, its rate is whatever the service says: nothing newer will come for it. */
const SETTLED_MS = 48 * 60 * 60 * 1000

export const emptyCache = (): FxCache => ({ v: FX_CACHE_VERSION, rates: {} })

export const cacheKey = (from: string, to: string, day: string): string => `${from}>${to}@${day}`

const KEY = /^([A-Z]{3})>([A-Z]{3})@(\d{4}-\d{2}-\d{2})$/

const isCached = (v: unknown): v is CachedRate => {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return isRate(r.rate) && isDate(r.asOf) && typeof r.at === 'number' && Number.isFinite(r.at)
}

/** Whatever storage held, as a cache: another version, another shape or a broken entry is dropped, never trusted. */
export function readCache(raw: unknown): FxCache {
  if (typeof raw !== 'object' || raw === null) return emptyCache()
  const c = raw as { v?: unknown; rates?: unknown }
  if (c.v !== FX_CACHE_VERSION || typeof c.rates !== 'object' || c.rates === null || Array.isArray(c.rates)) return emptyCache()
  const rates: Record<string, CachedRate> = {}
  for (const [key, value] of Object.entries(c.rates as Record<string, unknown>)) {
    const m = KEY.exec(key)
    if (m && isDate(m[3]) && isCached(value)) rates[key] = { rate: value.rate, asOf: value.asOf, at: value.at }
  }
  return { v: FX_CACHE_VERSION, rates }
}

/**
 * Whether a cached rate is the last word for the day it was asked for: it is
 * that very day's rate, or it was fetched long enough after the day that no
 * rate of that day can still be published (a weekend or a holiday keeps the
 * business day before it for good). One fetched before that (this morning's
 * `latest`, which is yesterday's rate until the bank publishes today's) may
 * still be replaced.
 */
export const isSettled = (entry: CachedRate, day: string): boolean => entry.asOf === day || entry.at >= utc(day) + SETTLED_MS

/**
 * The cached rate for a pair and day, and whether it can be used without
 * asking again: settled, or fetched less than FX_FRESH_MS ago. A stale one is
 * still returned (`fresh: false`): it is what is used when the service can't
 * be reached.
 */
export function cachedRate(cache: FxCache, from: string, to: string, day: string, now: number): { entry: CachedRate; fresh: boolean } | null {
  const entry = cache.rates[cacheKey(from, to, day)]
  if (!entry) return null
  const age = now - entry.at
  return { entry, fresh: isSettled(entry, day) || (age >= 0 && age < FX_FRESH_MS) }
}

/**
 * The newest rate this device has of a pair, whatever day it was asked for:
 * what an expense is converted with when the service can't be reached (the
 * interface says which day the rate is of). Newest by the day it is of, then
 * by when it was fetched.
 */
export function lastRate(cache: FxCache, from: string, to: string): CachedRate | null {
  const prefix = `${from}>${to}@`
  let best: CachedRate | null = null
  for (const [key, entry] of Object.entries(cache.rates)) {
    if (!key.startsWith(prefix)) continue
    if (best === null || entry.asOf > best.asOf || (entry.asOf === best.asOf && entry.at > best.at)) best = entry
  }
  return best
}

/**
 * The cache with one more rate, capped: over `max` entries the ones fetched
 * longest ago go first (so the newest of each pair in use stays for
 * `lastRate`).
 */
export function withRate(cache: FxCache, from: string, to: string, day: string, entry: CachedRate, max: number = FX_CACHE_MAX): FxCache {
  const rates = { ...cache.rates, [cacheKey(from, to, day)]: entry }
  const keys = Object.keys(rates)
  if (keys.length > max) {
    const oldestFirst = keys.sort((a, b) => rates[a].at - rates[b].at || (a < b ? -1 : 1))
    for (const key of oldestFirst.slice(0, keys.length - max)) delete rates[key]
  }
  return { v: FX_CACHE_VERSION, rates }
}
