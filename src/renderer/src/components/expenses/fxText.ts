import { humanDate, shortDate } from '../../lib/dates'
import type { RateOrigin } from '../../lib/expenseFx'
import type { StringKey } from '../../lib/strings'
import type { RateState } from './useRates'

type Translate = (key: StringKey, vars?: Record<string, string | number>) => string

/** The day a rate is of, as words: "Nov 13", with its year when it is not this one. */
export const rateDate = (asOf: string, today: string): string => (asOf.slice(0, 4) === today.slice(0, 4) ? shortDate(asOf) : humanDate(asOf))

/**
 * The one line under the rate and converted boxes: where the rate on screen
 * comes from ("Rate of Nov 13 (ECB)": the European Central Bank's, "BCE" in
 * Spanish; the saved rate of a day when the
 * service can't be reached, typed by the user, saved with the expense, what
 * the card was charged as a scanned picture shows), that
 * it is being fetched, or why there is none and what to do then. Plain words:
 * nothing spins.
 */
export function originLine(o: {
  origin: RateOrigin | null
  /** The fetch of the date's rate, when one is wanted. */
  state: RateState | undefined
  /** The rate shown is the one saved with the expense, standing in for the new date's (still asked for, or not to be had). */
  kept?: boolean
  /** The user emptied a box and is still in it. */
  typedEmpty?: boolean
  from: string
  to: string
  today: string
  t: Translate
}): string {
  const { origin, state, t } = o
  if (origin?.how === 'typed') return t('exp.fxFrom.typed')
  if (o.typedEmpty) return ''
  // A rate is on its way (whatever stands in the boxes meanwhile).
  if (state === 'loading') return t('exp.fxLoading')
  if (o.kept) return t('exp.fxKept')
  if (origin?.how === 'stored') return t('exp.fxFrom.stored')
  if (origin?.how === 'charged') return t('exp.fxFrom.charged')
  if (origin?.how === 'last') return t('exp.fxFrom.last', { date: rateDate(origin.asOf, o.today) })
  if (origin?.how === 'service' || origin?.how === 'cache') return t('exp.fxFrom.service', { date: rateDate(origin.asOf, o.today), source: t('exp.fxSource') })
  if (origin?.how === 'typedAll') return t('exp.fxFrom.typedAll')
  if (state !== undefined && !state.ok) return t(`exp.fxNone.${state.reason}`, { from: o.from, to: o.to })
  return ''
}
