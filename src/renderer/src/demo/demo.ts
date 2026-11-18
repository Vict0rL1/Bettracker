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
