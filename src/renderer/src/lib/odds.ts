import type { OddsFormat } from '../../../shared/types'

/**
 * Odds are stored as decimal (the payout per unit staked, > 1) and shown in
 * whichever format the user prefers. Conversions:
 *   american  +150 → 2.50    −120 → 1.8333…
 *   fractional 3/2 → 2.50    5/6  → 1.8333…
 */

/** Decimal → American, rounded to a whole number: 2.5 → +150, 1.8333 → −120. */
export function toAmerican(decimal: number): number {
  if (decimal >= 2) return Math.round((decimal - 1) * 100)
  return -Math.round(100 / (decimal - 1))
}

/** American → decimal. Odds between −100 and +100 don't exist; null for those. */
export function fromAmerican(american: number): number | null {
  if (!Number.isFinite(american) || Math.abs(american) < 100) return null
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american)
}

/**
 * Decimal → the closest fraction with a denominator a bettor would recognise
 * (up to 100), e.g. 2.5 → 3/2, 1.8333 → 5/6, 1.91 → 10/11.
 */
export function toFractional(decimal: number): string {
  const target = decimal - 1
  let best = { n: 1, d: 1, err: Infinity }
  for (let d = 1; d <= 100; d++) {
    const n = Math.round(target * d)
    if (n < 1) continue
    const err = Math.abs(n / d - target)
    if (err < best.err - 1e-9) best = { n, d, err }
  }
  const g = gcd(best.n, best.d)
  return `${best.n / g}/${best.d / g}`
}

/** "3/2" → 2.5. Also accepts "3-2" and "3:2". */
export function fromFractional(text: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[/:-]\s*(\d+(?:\.\d+)?)\s*$/.exec(text)
  if (!m) return null
  const n = Number(m[1])
  const d = Number(m[2])
  if (!(n > 0) || !(d > 0)) return null
  return 1 + n / d
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

/** What an empty odds box shows, per format. */
export const ODDS_PLACEHOLDER: Record<OddsFormat, string> = { american: '+150', decimal: '1.91', fractional: '3/2' }

/** The user-facing text for a stored decimal price. */
export function formatOdds(decimal: number, format: OddsFormat): string {
  switch (format) {
    case 'american': {
      const a = toAmerican(decimal)
      return a > 0 ? `+${a}` : String(a)
    }
    case 'fractional':
      return toFractional(decimal)
    case 'decimal':
      return decimal.toFixed(2)
  }
}

/**
 * Read what the user typed into the odds box and return the decimal price, or
 * null when it isn't one. Lenient about format: a fraction ("3/2") or a signed
 * American price ("+150", "-120") is understood whatever the setting; a bare
 * number follows the setting — "150" is +150 in American mode and 150.00 in
 * decimal mode — and a decimal comma is accepted.
 */
export function parseOdds(text: string, format: OddsFormat): number | null {
  const s = text.trim().replace(',', '.')
  if (s === '') return null
  if (/[/:]|\d-\d/.test(s)) return fromFractional(s)
  if (/^[+-]\d+$/.test(s)) return fromAmerican(Number(s))
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  const n = Number(s)
  if (format === 'american' && Number.isInteger(n) && n >= 100) return fromAmerican(n)
  return n > 1 ? n : null
}

/** The probability a decimal price implies, as a fraction of 1. */
export const impliedProbability = (decimal: number): number => 1 / decimal
