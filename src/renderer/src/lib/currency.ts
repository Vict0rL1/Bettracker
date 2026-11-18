import { isCurrencyCode } from '../../../shared/types'
import type { MoneyFormat } from './format'
import { LOCALE, type Lang } from './i18n'

/**
 * The currency expenses are shown in (Settings.expenseCurrency). Expenses
 * only: bets stay in dollars, and "units" never apply here. Changing it
 * converts nothing; it only changes how the stored amounts are written.
 * Amounts are written with en-US digits in both languages, as the bets'
 * dollars are, and each currency's own minor digits (CLP none, most two).
 */

export const DEFAULT_EXPENSE_CURRENCY = 'USD'

/** Offered in the picker, in this order. */
export const EXPENSE_CURRENCIES = ['USD', 'EUR', 'MXN', 'COP', 'ARS', 'CLP', 'PEN', 'UYU', 'BOB', 'PYG', 'CRC', 'GTQ', 'HNL', 'NIO', 'DOP', 'BRL', 'GBP', 'CAD'] as const

/** The list, plus `current` when it is a valid code not in it (set on another device or by a newer app). */
export function currencyOptions(current: string): string[] {
  const list: string[] = [...EXPENSE_CURRENCIES]
  return isCurrencyCode(current) && !list.includes(current) ? [...list, current] : list
}

/** The code itself when it is one Intl formats, else the default (a bad code never breaks a screen). */
function usable(code: string): string {
  if (!isCurrencyCode(code)) return DEFAULT_EXPENSE_CURRENCY
  try {
    new Intl.NumberFormat('en-US', { style: 'currency', currency: code })
    return code
  } catch {
    return DEFAULT_EXPENSE_CURRENCY
  }
}

const formatter = (code: string): Intl.NumberFormat => new Intl.NumberFormat('en-US', { style: 'currency', currency: code, currencyDisplay: 'symbol' })

/** Minor units Intl uses for the code (CLP and PYG 0, most 2); 2 for a code Intl rejects. */
export function currencyDigits(code: string): number {
  if (!isCurrencyCode(code)) return 2
  try {
    return formatter(code).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    return 2
  }
}

/** What en-US writes before the digits: the symbol and, after a letter one, its no-break space ("$", "MX$", "COP "). */
function prefixOf(nf: Intl.NumberFormat): string {
  const parts = nf.formatToParts(1)
  const at = parts.findIndex((p) => p.type === 'integer')
  return parts
    .slice(0, at < 0 ? parts.length : at)
    .map((p) => p.value)
    .join('')
}

/** The symbol en-US shows: "$", "€", "£", "MX$", "R$", "CA$", or the code ("COP"). */
export function currencySymbol(code: string): string {
  return formatter(usable(code)).formatToParts(1).find((p) => p.type === 'currency')?.value ?? usable(code)
}

/** Localised name ("Mexican Peso" / "peso mexicano") via Intl.DisplayNames; the code when unavailable. */
export function currencyName(code: string, lang: Lang): string {
  try {
    return new Intl.DisplayNames([LOCALE[lang]], { type: 'currency' }).of(code) ?? code
  } catch {
    return code
  }
}

/** The sign goes on what is shown: -0.001 reads as zero, never "-$0.00". */
function withSign(n: number, body: string, plus: boolean): string {
  if (!/[1-9]/.test(body)) return body
  if (n < 0) return `-${body}`
  return plus ? `+${body}` : body
}

const trimZero = (s: string): string => (s.endsWith('.0') ? s.slice(0, -2) : s)

const cache = new Map<string, MoneyFormat>()

/**
 * Every way the expenses show money, in this currency. Memoised per code, so
 * the context value (MoneyContext) stays the same object while it is in use.
 * A code Intl can't format falls back to dollars.
 *  plain:    -€12.50 / MX$1,234.50 / CLP 12,500 (the currency's own minor digits)
 *  signed:   +€12.50 (for the interface; expenses use plain)
 *  stake:    whole units from 1,000 ("MX$1,240"), else plain
 *  bankroll: as plain
 *  compact / axis: the symbol and a trimmed k ("€12", "€1.4k", "COP 12k")
 */
export function currencyFormat(code: string): MoneyFormat {
  const key = usable(code)
  const hit = cache.get(key)
  if (hit) return hit
  const nf = formatter(key)
  const whole = new Intl.NumberFormat('en-US', { style: 'currency', currency: key, currencyDisplay: 'symbol', minimumFractionDigits: 0, maximumFractionDigits: 0 })
  const prefix = prefixOf(nf)
  const plain = (n: number): string => withSign(n, nf.format(Math.abs(n)), false)
  const compactBody = (a: number): string => {
    if (a >= 100_000) return `${Math.round(a / 1000)}k`
    if (a >= 1000) return `${trimZero((a / 1000).toFixed(1))}k`
    return String(Math.round(a))
  }
  const axisBody = (a: number): string => (a >= 1000 ? `${trimZero((a / 1000).toFixed(1))}k` : String(Math.round(a)))
  const format: MoneyFormat = {
    unit: null,
    scale: (n) => n,
    signed: (n) => withSign(n, nf.format(Math.abs(n)), true),
    plain,
    compact: (n) => withSign(n, prefix + compactBody(Math.abs(n)), false),
    axis: (n) => withSign(n, prefix + axisBody(Math.abs(n)), false),
    stake: (n) => (Math.abs(n) >= 1000 ? withSign(n, whole.format(Math.round(Math.abs(n))), false) : plain(n)),
    bankroll: plain
  }
  cache.set(key, format)
  return format
}
