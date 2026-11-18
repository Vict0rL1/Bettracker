import { todayStr } from '../lib/dates'
import { cachedRate, emptyCache, isCode, isDate, lastRate, parseRateBody, rateDay, rateUrl, readCache, withRate, type CachedRate, type FxCache } from '../lib/fx'
import { readJson } from './offline'
import { writeExpendable } from './store'

/**
 * Exchange rates for an expense paid in another currency: asked of the
 * service (lib/fx.ts says which and how its answer is read), kept on this
 * device, and found there again when there is no connection.
 *
 * What leaves the device is one GET with two currency codes and a date. It
 * never goes through the Supabase client, and carries no cookie, no key, no
 * referrer and nothing of the user or the expense: not the amount, not the
 * merchant, not who asks.
 *
 * The cache is one key for the whole device, not per user: a rate is nobody's
 * data. It is expendable (data/store.ts drops it with the other caches when
 * storage is full) and capped (lib/fx.ts), and signing out leaves it.
 */

export const FX_CACHE_KEY = 'bettracker:fx'

/** How long the service gets to answer in full. A rate is a convenience: the sheet never waits long for one. */
export const FX_TIMEOUT_MS = 8_000

/** The first day the service has rates for: an older day's "not found" says nothing about the pair. */
const FIRST_DAY = '1999-01-04'

/**
 * 'service': just fetched. 'cache': this device's copy of that day's rate.
 * 'last': the service couldn't be reached and this is the newest rate of the
 * pair this device has, of whatever day (`asOf` says which).
 */
export type RateSource = 'service' | 'cache' | 'last'

/**
 * 'offline': no connection, and no rate of the pair on this device.
 * 'unsupported': the service has no rates for this pair (it answered so).
 * 'unavailable': it couldn't be reached, took too long or answered something
 * unreadable, and there is no rate of the pair on this device.
 */
export type RateOutcome = { ok: true; rate: number; asOf: string; source: RateSource } | { ok: false; reason: 'offline' | 'unsupported' | 'unavailable' }

export interface RateOptions {
  /** Gives up at once (the sheet's date or currency changed, or it closed). The outcome is then to be ignored. */
  signal?: AbortSignal
}

export interface RatesDeps {
  fetch: typeof fetch
  /** Milliseconds since the epoch. */
  now: () => number
  /** The local calendar day, YYYY-MM-DD. */
  today: () => string
  /** Whether the browser thinks it has a connection. */
  online: () => boolean
  timeoutMs: number
}

const GONE: RateOutcome = { ok: false, reason: 'unavailable' }

/** A status that says "not this pair" rather than "not now": any 4xx but a timeout, a too-early or a rate limit. */
const refusesPair = (status: number): boolean => status >= 400 && status <= 499 && status !== 408 && status !== 425 && status !== 429

/**
 * The rates as one object with its own session memory (the pairs the service
 * said it doesn't have, and the cache when storage can't hold it). The app
 * uses the one below; the tests make their own with a fetch that answers.
 */
export function createRates(deps: Partial<RatesDeps> = {}): { getRate: (from: string, to: string, date: string, opts?: RateOptions) => Promise<RateOutcome> } {
  const d: RatesDeps = {
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    today: todayStr,
    online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    timeoutMs: FX_TIMEOUT_MS,
    ...deps
  }
  /** Pairs the service refused, until the app is opened again. */
  const unsupported = new Set<string>()
  /** The cache as last written here, for a device whose storage can't keep it. */
  let memory: FxCache | null = null

  const load = (): FxCache => {
    const stored = readJson<unknown>(FX_CACHE_KEY)
    return stored === null ? (memory ?? emptyCache()) : readCache(stored)
  }
  const save = (cache: FxCache): void => {
    memory = cache
    writeExpendable(FX_CACHE_KEY, cache)
  }

  /** One request, given up after the timeout or when the caller does. Resolves with the answer, or null when none came. */
  async function ask(url: string, signal: AbortSignal | undefined): Promise<{ status: number; body: unknown } | null> {
    const controller = new AbortController()
    const forward = (): void => controller.abort()
    if (signal?.aborted) return null
    signal?.addEventListener('abort', forward, { once: true })
    const timer = setTimeout(() => controller.abort(), d.timeoutMs)
    try {
      // No credentials, no referrer, no custom header (so no preflight): two currency codes and a date.
      const res = await d.fetch(url, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal })
      if (!res.ok) return { status: res.status, body: null }
      // The body within the same time: an answer that stops halfway is no answer.
      return { status: res.status, body: (await res.json()) as unknown }
    } catch {
      // No connection, a block, the timeout, the caller's abort, or a body that is no JSON.
      return null
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forward)
    }
  }

  async function getRate(from: string, to: string, date: string, opts: RateOptions = {}): Promise<RateOutcome> {
    try {
      if (!isCode(from) || !isCode(to)) return { ok: false, reason: 'unsupported' }
      if (!isDate(date)) return GONE
      const today = d.today()
      const day = rateDay(date, today)
      if (from === to) return { ok: true, rate: 1, asOf: day, source: 'cache' }
      const pair = `${from}>${to}`
      const hit = cachedRate(load(), from, to, day, d.now())
      if (hit?.fresh) return { ok: true, rate: hit.entry.rate, asOf: hit.entry.asOf, source: 'cache' }
      if (unsupported.has(pair)) return { ok: false, reason: 'unsupported' }

      /** Without the service: this day's rate as last fetched, else the newest of the pair, else nothing. */
      const without = (reason: 'offline' | 'unavailable'): RateOutcome => {
        if (hit) return { ok: true, rate: hit.entry.rate, asOf: hit.entry.asOf, source: 'cache' }
        const last = lastRate(load(), from, to)
        return last ? { ok: true, rate: last.rate, asOf: last.asOf, source: 'last' } : { ok: false, reason }
      }

      if (opts.signal?.aborted) return GONE
      if (!d.online()) return without('offline')
      const url = rateUrl(from, to, date, today)
      if (url === null) return GONE
      const answer = await ask(url, opts.signal)
      if (opts.signal?.aborted) return GONE
      if (answer === null) return without(d.online() ? 'unavailable' : 'offline')
      if (refusesPair(answer.status)) {
        if (day >= FIRST_DAY) unsupported.add(pair)
        return { ok: false, reason: 'unsupported' }
      }
      const parsed = answer.body === null ? null : parseRateBody(answer.body, from, to)
      if (parsed === null) return without('unavailable')
      const entry: CachedRate = { rate: parsed.rate, asOf: parsed.asOf, at: d.now() }
      // Read again: another window may have stored rates meanwhile.
      save(withRate(load(), from, to, day, entry))
      return { ok: true, rate: entry.rate, asOf: entry.asOf, source: 'service' }
    } catch {
      // Never throws: a rate is a convenience, and the sheet works without one.
      return GONE
    }
  }

  return { getRate }
}

/**
 * The rate of 1 `from` in `to` on `date` (YYYY-MM-DD; today or later asks
 * for the newest). Never throws. See RateOutcome for what comes back.
 */
export const getRate = createRates().getRate
