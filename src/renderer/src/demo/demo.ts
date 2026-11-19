import { clearUserData, queueKeys } from '../data/offline'

/** The one account the demo has. */
export const DEMO_USER = { id: '00000000-0000-4000-8000-000000000001', email: 'demo@example.com' }

/** The fake server's keys in localStorage. */
export const DEMO_PREFIX = 'demo:'

/** The fake server's tables, by the name each is stored under (after the prefix). */
const TABLES = ['rows', 'moves', 'expenses', 'expense-cards', 'expense-budgets'] as const

/**
 * Whether the demo holds anything that emptying or replacing it would lose:
 * a row in any of the fake server's tables, settings changed from the
 * defaults, or a change still waiting on this device to be sent. Unreadable
 * storage counts as nothing (there is nothing to lose that can be read).
 */
export function demoHasData(): boolean {
  const filled = (key: string): boolean => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
      return Array.isArray(value) ? value.length > 0 : value !== null
    } catch {
      return false
    }
  }
  const q = queueKeys(DEMO_USER.id)
  return [...TABLES.map((t) => DEMO_PREFIX + t), `${DEMO_PREFIX}settings`, q.outbox, q.moves, q.settings, q.expenses, q.expenseCards, q.expenseBudgets].some(filled)
}

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
