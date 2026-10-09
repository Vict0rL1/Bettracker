import type { OddsFormat } from '../../../shared/types'
import { formatOdds } from './odds'

/**
 * The odds bands the breakdown groups by — defined here and nowhere else.
 * Bounds are decimal prices; each band runs from the previous bound
 * (exclusive) up to its own (inclusive). In American terms:
 *   heavy favorite  −200 and shorter        (≤ 1.50)
 *   favorite        −199 to −111            (1.50 < odds ≤ 1.90)
 *   even            −110 to +110            (1.90 < odds ≤ 2.10)
 *   underdog        +111 to +250            (2.10 < odds ≤ 3.50)
 *   longshot        longer than +250        (> 3.50)
 */
export type BandKey = 'heavyFav' | 'fav' | 'even' | 'dog' | 'longshot'

export interface OddsBand {
  key: BandKey
  /** Inclusive upper bound, decimal; Infinity for the last band. */
  max: number
}

export const ODDS_BANDS: readonly OddsBand[] = [
  { key: 'heavyFav', max: 1.5 },
  { key: 'fav', max: 1.9 },
  { key: 'even', max: 2.1 },
  { key: 'dog', max: 3.5 },
  { key: 'longshot', max: Infinity }
]

/** The band a price falls in; null when no price was recorded (left out, like an untagged bet). */
export function bandOf(odds: number | null): BandKey | null {
  if (odds === null) return null
  for (const band of ODDS_BANDS) if (odds <= band.max) return band.key
  return null
}

export const bandIndex = (key: string): number => ODDS_BANDS.findIndex((b) => b.key === key)

/** A band's decimal bounds: `lo` exclusive (1 for the first), `hi` inclusive (Infinity for the last). */
export function bandBounds(key: BandKey): { lo: number; hi: number } {
  const i = bandIndex(key)
  return { lo: i === 0 ? 1 : ODDS_BANDS[i - 1].max, hi: ODDS_BANDS[i].max }
}

/** The band's edges in the user's odds format: "≤ -200", "-200 – -111", "> +250". */
export function bandRangeText(key: BandKey, format: OddsFormat): string {
  const { lo, hi } = bandBounds(key)
  if (lo === 1) return `≤ ${formatOdds(hi, format)}`
  if (hi === Infinity) return `> ${formatOdds(lo, format)}`
  return `${formatOdds(lo, format)} – ${formatOdds(hi, format)}`
}
