const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

/** Signed currency: +$1,234.56 / -$45.00 / $0.00. */
export function fmtMoney(n: number): string {
  const body = usd.format(Math.abs(n))
  if (n > 0) return `+${body}`
  if (n < 0) return `-${body}`
  return body
}

/** Currency with the natural sign only: $1,234.56 / -$45.00. */
export function fmtMoneyPlain(n: number): string {
  return n < 0 ? `-${usd.format(Math.abs(n))}` : usd.format(n)
}

const trimZero = (s: string): string => (s.endsWith('.0') ? s.slice(0, -2) : s)

/**
 * Compact signed amount for tight spots (calendar tiles): +$120, -$335, -$1.4k.
 * Whole dollars only — a calendar cell is 46px wide on a phone and the exact
 * figure is one tap away in the day dialog.
 */
export function fmtMoneyCompact(n: number): string {
  const a = Math.abs(n)
  const sign = n > 0 ? '+' : n < 0 ? '-' : ''
  let body: string
  if (a >= 100_000) body = `$${Math.round(a / 1000)}k`
  else if (a >= 1000) body = `$${trimZero((a / 1000).toFixed(1))}k`
  else body = `$${Math.round(a)}`
  return sign + body
}

/** Axis ticks: unsigned-compact with natural minus. */
export function axisMoney(n: number): string {
  const a = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (a >= 1000) return `${sign}$${trimZero((a / 1000).toFixed(1))}k`
  return `${sign}$${Math.round(a)}`
}

export const fmtPct = (n: number): string => `${Math.round(n)}%`

/**
 * Signed percentage for ROI, to one decimal — a bettor's edge lives in tenths
 * of a point, so rounding to whole percent throws away the signal.
 */
export function fmtPctSigned(n: number): string {
  const body = `${Math.abs(n).toFixed(1)}%`
  if (n > 0) return `+${body}`
  if (n < 0) return `-${body}`
  return body
}

/** Unsigned money for "amount staked" style figures: $1,240 (no cents past $1k). */
export function fmtStake(n: number): string {
  return n >= 1000 ? `$${Math.round(n).toLocaleString('en-US')}` : usd.format(n)
}

/** Decimal odds, always two places: 1.91, 2.50, 11.00. */
export const fmtOdds = (n: number): string => n.toFixed(2)

/** A probability already expressed as a percentage: 52%. */
export const fmtProb = (pct: number): string => `${Math.round(pct)}%`

const pct1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

/**
 * A share to one decimal: 4.2% / 150.0%. The stake hint uses it, where 5.0%
 * and 5.1% are on either side of the warning, so whole percent won't do.
 */
export function fmtPct1(n: number): string {
  return `${withSign(n, pct1.format(Math.abs(n)), false)}%`
}

/**
 * Every way the app shows an amount of money, in dollars or in units. Each
 * method takes DOLLARS and does the dividing itself, so a caller never has to
 * know which one the user picked.
 */
export interface MoneyFormat {
  /** Dollars per unit, or null when amounts show in dollars. */
  unit: number | null
  /** Dollars into what is shown: units, or the same dollars. */
  scale(n: number): number
  /** Signed, to the cent: +$1,234.56 / +2.35u. */
  signed(n: number): string
  /** Natural minus, to the cent: -$45.00 / -3.00u. */
  plain(n: number): string
  /** Calendar tiles: +$120 / +2.3u. */
  compact(n: number): string
  /** Chart axis ticks: -$5 / 1.5u. */
  axis(n: number): string
  /** Amounts staked: $1,240 / 2.5u. */
  stake(n: number): string
  /** The bankroll itself: like a stake, but it can be below zero. */
  bankroll(n: number): string
}

/** The formatters alone, for figures that are already scaled (see scaledFormat). */
export type ScaledFormat = Omit<MoneyFormat, 'unit' | 'scale'>

/**
 * The sign goes on what is shown, not on the raw number: -0.001 units reads
 * 0.00u, never -0.00u.
 */
function withSign(n: number, body: string, plus: boolean): string {
  if (!/[1-9]/.test(body)) return body
  if (n < 0) return `-${body}`
  return plus ? `+${body}` : body
}

const dollars: ScaledFormat = {
  signed: fmtMoney,
  plain: fmtMoneyPlain,
  compact: fmtMoneyCompact,
  axis: axisMoney,
  stake: fmtStake,
  // A bankroll can go below zero, which fmtStake was never asked to show: the
  // minus goes in front, so -2180 reads -$2,180 the way 2180 reads $2,180.
  bankroll: (n) => withSign(n, fmtStake(Math.abs(n)), false)
}

// Units are plain numbers with a "u", in en-US digits in both languages: the
// dollar amounts are written that way too.
const cents2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const upTo2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })
const upTo2Bare = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, useGrouping: false })

/**
 * Calendar tile body: 2.3 under 10 units, whole up to 999, then 1.2k. Each
 * tier is picked on the rounded figure, so 9.96 reads 10 and 999.6 reads 1k.
 */
function compactUnits(a: number): string {
  const tenths = a.toFixed(1)
  if (Number(tenths) < 10) return trimZero(tenths)
  const whole = Math.round(a)
  if (whole < 1000) return String(whole)
  return `${trimZero((a / 1000).toFixed(1))}k`
}

/** Axis tick body: up to two decimals (1.5, 0.25), then 1.2k like axisMoney. */
function axisUnits(a: number): string {
  const body = upTo2Bare.format(a)
  return Number(body) < 1000 ? body : `${trimZero((a / 1000).toFixed(1))}k`
}

const units: ScaledFormat = {
  signed: (n) => `${withSign(n, cents2.format(Math.abs(n)), true)}u`,
  plain: (n) => `${withSign(n, cents2.format(Math.abs(n)), false)}u`,
  compact: (n) => `${withSign(n, compactUnits(Math.abs(n)), true)}u`,
  axis: (n) => `${withSign(n, axisUnits(Math.abs(n)), false)}u`,
  stake: (n) => `${withSign(n, upTo2.format(Math.abs(n)), false)}u`,
  bankroll: (n) => `${withSign(n, upTo2.format(Math.abs(n)), false)}u`
}

/**
 * How money is shown: in dollars with no unit (or a unit that is not a
 * positive number, which would divide by zero), in units otherwise. Dollars
 * are the legacy formatters, unchanged.
 */
export function moneyFormat(unit: number | null): MoneyFormat {
  if (unit === null || !Number.isFinite(unit) || unit <= 0) return { unit: null, scale: (n) => n, ...dollars }
  const scale = (n: number): number => n / unit
  return {
    unit,
    scale,
    signed: (n) => units.signed(scale(n)),
    plain: (n) => units.plain(scale(n)),
    compact: (n) => units.compact(scale(n)),
    axis: (n) => units.axis(scale(n)),
    stake: (n) => units.stake(scale(n)),
    bankroll: (n) => units.bankroll(scale(n))
  }
}

/**
 * The same formatters over figures that are ALREADY in what is shown. The
 * chart scales its data before drawing, so the axis picks ticks on whole
 * units rather than on whole dollars that land at 0.35u.
 */
export const scaledFormat = (inUnits: boolean): ScaledFormat => (inUnits ? units : dollars)
