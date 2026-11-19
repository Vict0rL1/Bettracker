import { isCurrencyCode } from '../../../shared/types'
import type { MoneyFormat } from './format'
import { LOCALE, type Lang } from './i18n'

/**
 * The currency expenses are shown in (Settings.expenseCurrency): the user's
 * MAIN currency. Expenses only: bets stay in dollars, and "units" never
 * apply here. Changing it converts nothing; it only changes how the stored
 * amounts are written. Amounts are written with en-US digits in both
 * languages, as the bets' dollars are, and each currency's own minor digits
 * (CLP none, most two).
 *
 * Two ways of writing money, on purpose:
 *  - the main currency with its NARROW symbol ("$" for Canadian, Mexican and
 *    US dollars alike, "€", "£", "R$"): it is the one currency of every total
 *    on the screen, and its code stands next to the month's title;
 *  - an amount in ANOTHER currency (what an expense was actually paid in)
 *    with its code, "USD 12.00" (codeAmount): never a bare "$" that could be
 *    taken for the main one.
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

/**
 * How the main currency's symbol is asked for: the narrow one, or the plain
 * symbol on an engine too old to know `narrowSymbol` (it throws on the
 * option; Safari before 14.1): there Canadian dollars read "CA$" rather than
 * the screen not rendering at all.
 */
export function symbolDisplay(make: (display: 'narrowSymbol') => unknown = (display) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencyDisplay: display })): 'narrowSymbol' | 'symbol' {
  try {
    make('narrowSymbol')
    return 'narrowSymbol'
  } catch {
    return 'symbol'
  }
}

const DISPLAY = symbolDisplay()

const formatter = (code: string): Intl.NumberFormat => new Intl.NumberFormat('en-US', { style: 'currency', currency: code, currencyDisplay: DISPLAY })

/** Minor units Intl uses for the code (CLP and PYG 0, most 2); 2 for a code Intl rejects. */
export function currencyDigits(code: string): number {
  if (!isCurrencyCode(code)) return 2
  try {
    return formatter(code).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    return 2
  }
}

/** What en-US writes before the digits: the symbol and, after a letter one, its no-break space ("$", "R$", "PEN" and the space). */
function prefixOf(nf: Intl.NumberFormat): string {
  const parts = nf.formatToParts(1)
  const at = parts.findIndex((p) => p.type === 'integer')
  return parts
    .slice(0, at < 0 ? parts.length : at)
    .map((p) => p.value)
    .join('')
}

/** The narrow symbol en-US shows: "$" (US, Canadian, Mexican dollars and most pesos), "€", "£", "R$", "Bs", or the code where there is none ("PEN"). */
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
 * A code Intl can't format falls back to dollars. The symbol is the narrow
 * one (see the top of this file).
 *  plain:    -€12.50 / $1,234.50 / $12,500 (pesos: the currency's own minor digits) / PEN 12.50
 *  signed:   +€12.50 (for the interface; expenses use plain)
 *  stake:    whole units from 1,000 ("$1,240"), else plain
 *  bankroll: as plain
 *  compact / axis: the symbol and a trimmed k ("€12", "€1.4k", "PEN 12k")
 */
export function currencyFormat(code: string): MoneyFormat {
  const key = usable(code)
  const hit = cache.get(key)
  if (hit) return hit
  const nf = formatter(key)
  const whole = new Intl.NumberFormat('en-US', { style: 'currency', currency: key, currencyDisplay: DISPLAY, minimumFractionDigits: 0, maximumFractionDigits: 0 })
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

const codeFormats = new Map<string, Intl.NumberFormat>()

/** A code and an amount with nothing known of the currency: the code, a no-break space, two decimals. */
const plainCode = (n: number, code: string): string => `${n < 0 && Math.round(Math.abs(n) * 100) !== 0 ? '-' : ''}${code}\u00a0${Math.abs(n).toFixed(2)}`

/**
 * An amount in a currency that is NOT the main one, written with its code:
 * "USD 12.00", "-USD 5.00" (a refund), "COP 12,500", "JPY 1,200". The code
 * and the digits are held together by a no-break space. In the currency's
 * own minor digits; cents a currency doesn't have (they are stored with two
 * decimals whatever the currency) are kept rather than rounded away unseen.
 * A code that is no code is written as it is, with two decimals.
 */
export function codeAmount(n: number, code: string): string {
  if (!isCurrencyCode(code)) return plainCode(n, code)
  let nf = codeFormats.get(code)
  if (!nf) {
    const digits = currencyDigits(code)
    try {
      nf = new Intl.NumberFormat('en-US', { style: 'currency', currency: code, currencyDisplay: 'code', minimumFractionDigits: digits, maximumFractionDigits: Math.max(2, digits) })
    } catch {
      return plainCode(n, code)
    }
    codeFormats.set(code, nf)
  }
  return withSign(n, nf.format(Math.abs(n)), false)
}

/**
 * The currencies an expense can be paid in, for the sheet's and the review's
 * select: the main one first, then the last other one used on this device
 * (when there is one), then dollars, then the rest of the picker's list, and
 * `also` (the currency of the expense being edited, or the one read from a
 * picture) when it is a code not in the list. Each once.
 */
export function payCurrencyOptions(main: string, lastOther: string | null, also: string | null = null): string[] {
  const order = [main, lastOther, DEFAULT_EXPENSE_CURRENCY, ...EXPENSE_CURRENCIES, also]
  const out: string[] = []
  for (const code of order) if (isCurrencyCode(code) && !out.includes(code)) out.push(code)
  return out
}
