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

/** Compact signed amount for tight spots (calendar tiles): +$120, -$1.4k. */
export function fmtMoneyCompact(n: number): string {
  const a = Math.abs(n)
  const sign = n > 0 ? '+' : n < 0 ? '-' : ''
  let body: string
  if (a >= 100_000) body = `$${Math.round(a / 1000)}k`
  else if (a >= 1000) body = `$${trimZero((a / 1000).toFixed(1))}k`
  else if (Number.isInteger(a)) body = `$${a}`
  else body = `$${a.toFixed(2)}`
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
