import { clearUserData } from '../data/offline'

/** The one account the demo has. */
export const DEMO_USER = { id: '00000000-0000-4000-8000-000000000001', email: 'demo@example.com' }

/** The fake server's keys in localStorage. */
export const DEMO_PREFIX = 'demo:'

/**
 * Empties the demo: the fake server's tables and this device's copy of them.
 * Preferences that belong to the device (theme, language, date range) stay.
 */
export function resetDemo(): void {
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith(DEMO_PREFIX)) keys.push(k)
    }
    for (const k of keys) localStorage.removeItem(k)
  } catch {
    // storage unavailable — nothing was kept
  }
  clearUserData(DEMO_USER.id)
}

/** A version 4 UUID from `crypto.getRandomValues`, which every page has. */
export function randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * The app gives every new bet, deposit and queued change an id from
 * `crypto.randomUUID`, which browsers only offer on https or localhost. The
 * demo's Network URL is plain http on the LAN, so on a phone it would have
 * none; the demo supplies it. (The real app is served over https.)
 */
export function ensureRandomUUID(): void {
  const c = crypto as Crypto & { randomUUID?: () => string }
  if (typeof c.randomUUID !== 'function') c.randomUUID = randomUUID
}
