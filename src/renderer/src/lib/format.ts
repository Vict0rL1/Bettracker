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
