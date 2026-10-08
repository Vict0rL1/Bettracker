import { useCallback, useSyncExternalStore } from 'react'
import { en, es, type StringKey } from './strings'

export type Lang = 'en' | 'es'

const KEY = 'bettracker:lang'
const DICT: Record<Lang, Record<StringKey, string>> = { en, es }

/** BCP 47 tag for date formatting in each language. */
export const LOCALE: Record<Lang, string> = { en: 'en-US', es: 'es-ES' }

function stored(): Lang | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw === 'en' || raw === 'es' ? raw : null
  } catch {
    return null
  }
}

/** The browser's language, narrowed to what we ship. */
function browserLang(): Lang {
  const tag = typeof navigator !== 'undefined' ? (navigator.language ?? '') : ''
  return tag.toLowerCase().startsWith('es') ? 'es' : 'en'
}

// A module-level store rather than context: the dictionary is read from
// plain functions (date formatting, validation messages) as well as from
// components, and there is exactly one language per page.
let current: Lang = stored() ?? browserLang()
const listeners = new Set<() => void>()

export const getLang = (): Lang => current

export function setLang(next: Lang): void {
  if (next === current) return
  current = next
  try {
    localStorage.setItem(KEY, next)
  } catch {
    // Storage unavailable — the choice just won't survive a reload.
  }
  if (typeof document !== 'undefined') document.documentElement.lang = next
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

type Vars = Record<string, string | number>

function fill(template: string, vars?: Vars): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m))
}

/** Look a string up in the current language and fill its placeholders. */
export function t(key: StringKey, vars?: Vars): string {
  return fill(DICT[current][key], vars)
}

/**
 * A counted noun: `tn('bet', 3)` → "3 bets" / "3 apuestas". Both languages
 * distinguish one from many the same way, so one/other is all we need; the
 * count is passed as `{n}` so a language could move it.
 */
export function tn(base: 'bet' | 'day' | 'line' | 'freeBet', n: number, vars?: Vars): string {
  const key = `${base}_${n === 1 ? 'one' : 'other'}` as StringKey
  return fill(DICT[current][key], { n, ...vars })
}

/**
 * Components call this so they re-render when the language changes. It
 * returns the same `t`/`tn` as above; the hook is what makes them reactive.
 */
export function useLang(): { lang: Lang; t: typeof t; tn: typeof tn; setLang: (l: Lang) => void; toggle: () => void } {
  const lang = useSyncExternalStore(subscribe, getLang, getLang)
  const toggle = useCallback(() => setLang(getLang() === 'en' ? 'es' : 'en'), [])
  return { lang, t, tn, setLang, toggle }
}

// Set once at load so screen readers and hyphenation match from the start.
if (typeof document !== 'undefined') document.documentElement.lang = current
