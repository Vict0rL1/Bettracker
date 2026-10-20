import type { OddsFormat } from '../../../shared/types'
import { StorageWriteError } from '../data/store'
import { ODDS_PLACEHOLDER } from './odds'
import type { StringKey } from './strings'
import { InputError, MAX_AMOUNT, round2, storableOdds } from './validate'

/**
 * What the bet forms say about a box, in words, next to it. The boxes never
 * rely on a disabled button or a red border alone: each problem has a
 * sentence, tied to its box (aria-describedby).
 */
export interface Problem {
  key: StringKey
  vars?: Record<string, string | number>
}

/** A money box as typed: '' is empty, anything else is read as a number. */
export const moneyOf = (text: string): number | null => (text.trim() === '' ? null : parseFloat(text))

/** The stake box. Empty is a problem unless the stake may go unrecorded (a bet from before stakes). */
export function stakeProblem(text: string, optional = false): Problem | null {
  const n = moneyOf(text)
  if (n === null) return optional ? null : { key: 'field.stakeRequired' }
  if (!Number.isFinite(n) || n < 0) return { key: 'field.stakeInvalid' }
  if (n > MAX_AMOUNT) return { key: 'field.tooBig' }
  return null
}

/** An odds box: empty is fine; anything typed must be a price the database keeps. */
export function oddsProblem(text: string, parsed: number | null, format: OddsFormat): Problem | null {
  if (text.trim() === '') return null
  if (parsed !== null && storableOdds(parsed)) return null
  return { key: 'field.oddsInvalid', vars: { example: ODDS_PLACEHOLDER[format] } }
}

/**
 * A result box (the profit of a win, the amount a loss cost): more than 0
 * once rounded to cents, as stored. `zeroOk` lets a lost free bet through at
 * 0 (or empty): it cost nothing.
 */
export function resultProblem(text: string, zeroOk = false): Problem | null {
  const n = moneyOf(text)
  if (n === null) return zeroOk ? null : { key: 'field.resultRequired' }
  if (!Number.isFinite(n) || n < 0) return { key: 'field.resultInvalid' }
  if (n > MAX_AMOUNT) return { key: 'field.tooBig' }
  if (round2(n) === 0 && !zeroOk) return { key: n === 0 ? 'field.resultRequired' : 'field.resultRoundsZero' }
  return null
}

/** True when a stake typed is a free bet: no cash at risk once rounded to cents. */
export const isFreeStake = (stake: number | null): boolean => stake !== null && Number.isFinite(stake) && round2(stake) === 0

type Translate = (key: StringKey, vars?: Record<string, string | number>) => string

/** A change the app refused, in the user's words: what the form says above its button. */
export function refusalText(err: unknown, t: Translate): string {
  if (err instanceof InputError) return t(`invalid.${err.code}` as StringKey, err.vars)
  if (err instanceof StorageWriteError) return t('toast.notSaved')
  const message = err instanceof Error ? err.message : ''
  return message || t('common.error')
}
