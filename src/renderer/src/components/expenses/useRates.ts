import { useEffect, useMemo, useRef, useState } from 'react'
import { getRate, type RateOutcome } from '../../data/fxRates'
import { rateKey, type FxAuto } from '../../lib/expenseFx'
import { isDate } from '../../lib/fx'

/** A date's rate while it is asked for, once it came, or why it didn't. */
export type RateState = 'loading' | RateOutcome

export interface Rates {
  /** What is known of a date's rate; undefined: not asked for (rates are not wanted now, or it is no date). */
  of: (date: string) => RateState | undefined
  /** The dates that have a rate, as the conversion takes them (lib/expenseFx.ts). */
  found: Readonly<Record<string, FxAuto | undefined>>
  /** A wanted date is still being asked for. */
  loading: boolean
}

/** The rates of several currencies, each for some dates (the scan review's rows). */
export interface PairRates {
  /** What is known of a currency's rate on a date; undefined: not asked for (rates are not wanted now, or it is no date). */
  of: (from: string, date: string) => RateState | undefined
  /** The currencies and dates that have a rate, by rateKey(from, date). */
  found: Readonly<Record<string, FxAuto | undefined>>
  /** A wanted rate is still being asked for. */
  loading: boolean
}

const keyOf = (from: string, to: string, date: string): string => `${from}>${to}@${date}`

/** At most this many requests out at once (a review can hold many dates; the cache answers most without one). */
const AT_ONCE = 3

/** A failure that may pass: asked for again when there is a reason to. A pair the service doesn't have stays so. */
const passing = (v: RateOutcome): boolean => !v.ok && v.reason !== 'unsupported'

/**
 * The rates in `to` of some currencies on some dates (`wants`: the review's
 * rows paid in another currency), kept while the component lives. Nothing is
 * asked while `enabled` is false (every amount is in the main currency, or
 * the user typed their own rate), and nothing ever blocks: a rate is
 * 'loading' until its answer comes, and typing goes on meanwhile. A currency
 * and date no longer wanted is given up.
 *
 * A rate that didn't come is asked for again when the connection comes back,
 * and when rates are wanted again after not being (the user emptied the rate
 * they had typed): never in a loop.
 */
export function useRatePairs(o: { enabled: boolean; to: string; wants: readonly { from: string; date: string }[] }): PairRates {
  const { enabled, to } = o
  const [known, setKnown] = useState<Readonly<Record<string, RateOutcome>>>({})
  const out = useRef(new Map<string, AbortController>())
  const wasEnabled = useRef(false)
  const alive = useRef(true)
  const wantedKey = [...new Set(o.wants.filter((w) => isDate(w.date)).map((w) => rateKey(w.from, w.date)))].sort().join(',')
  const wanted = useMemo(
    () =>
      wantedKey === ''
        ? []
        : wantedKey.split(',').map((k) => {
            const at = k.lastIndexOf('@')
            return { from: k.slice(0, at), date: k.slice(at + 1) }
          }),
    [wantedKey]
  )

  const forgetFailures = (): void =>
    setKnown((k) => {
      const kept = Object.entries(k).filter(([, v]) => !passing(v))
      return kept.length === Object.keys(k).length ? k : Object.fromEntries(kept)
    })

  useEffect(() => {
    alive.current = true
    const requests = out.current
    const onOnline = (): void => forgetFailures()
    window.addEventListener('online', onOnline)
    return () => {
      alive.current = false
      window.removeEventListener('online', onOnline)
      for (const c of requests.values()) c.abort()
      requests.clear()
    }
  }, [])

  useEffect(() => {
    const flipped = enabled && !wasEnabled.current
    wasEnabled.current = enabled
    // Wanted again after not being: what failed before gets one more try.
    if (flipped) forgetFailures()
    const want = new Set(enabled ? wanted.map((w) => keyOf(w.from, to, w.date)) : [])
    // Given up: what is out for a date (or a pair) no longer wanted.
    for (const [key, controller] of out.current) {
      if (want.has(key)) continue
      controller.abort()
      out.current.delete(key)
    }
    if (!enabled) return
    for (const { from, date } of wanted) {
      if (out.current.size >= AT_ONCE) break
      const key = keyOf(from, to, date)
      if (known[key] !== undefined || out.current.has(key)) continue
      const controller = new AbortController()
      out.current.set(key, controller)
      void getRate(from, to, date, { signal: controller.signal }).then((outcome) => {
        // Given up meanwhile: its outcome says nothing.
        if (controller.signal.aborted || out.current.get(key) !== controller) return
        out.current.delete(key)
        if (alive.current) setKnown((k) => ({ ...k, [key]: outcome }))
      })
    }
  }, [enabled, to, wanted, known])

  return useMemo(() => {
    const found: Record<string, FxAuto | undefined> = {}
    let loading = false
    for (const { from, date } of wanted) {
      const state = known[keyOf(from, to, date)]
      if (state === undefined) loading = true
      else if (state.ok) found[rateKey(from, date)] = { rate: state.rate, asOf: state.asOf, source: state.source }
    }
    const of = (from: string, date: string): RateState | undefined => (enabled && isDate(date) ? (known[keyOf(from, to, date)] ?? 'loading') : undefined)
    return { of, found, loading: enabled && loading }
  }, [known, wanted, to, enabled])
}

/**
 * The rates of 1 `from` in `to` for some dates (the sheet's one), as
 * useRatePairs gets them: the same asking, waiting and giving up.
 */
export function useRates(o: { enabled: boolean; from: string; to: string; dates: readonly string[] }): Rates {
  const { from, dates } = o
  const wants = useMemo(() => dates.map((date) => ({ from, date })), [from, dates])
  const pairs = useRatePairs({ enabled: o.enabled, to: o.to, wants })
  return useMemo(() => {
    const found: Record<string, FxAuto | undefined> = {}
    for (const date of dates) {
      const rate = pairs.found[rateKey(from, date)]
      if (rate) found[date] = rate
    }
    return { of: (date: string) => pairs.of(from, date), found, loading: pairs.loading }
  }, [pairs, from, dates])
}
