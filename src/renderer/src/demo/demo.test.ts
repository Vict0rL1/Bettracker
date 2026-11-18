import { beforeEach, describe, expect, it } from 'vitest'
import { DEMO_USER, resetDemo } from './demo'

beforeEach(() => localStorage.clear())

describe('resetDemo', () => {
  it("empties the fake server and the demo user's copy on this device, and nothing else", () => {
    const uid = DEMO_USER.id
    const demoKeys = [
      'demo:rows',
      'demo:moves',
      'demo:settings',
      'demo:signed-out',
      'demo:migrated',
      'demo:expenses',
      'demo:expense-cards',
      'demo:expense-budgets',
      'demo:migrated-008',
      'demo:migrated-009',
      'demo:ai-calls',
      'demo:ai-answered',
      'demo:ai-last'
    ]
    const rowKeys = ['expenses', 'expense-cards', 'expense-budgets'].flatMap((n) => [
      `bettracker:${n}:${uid}`,
      `bettracker:${n}-outbox:${uid}`,
      `bettracker:${n}-refused:${uid}`,
      `bettracker:confirmed-${n}:${uid}`
    ])
    const userKeys = [
      `bettracker:cache:${uid}`,
      `bettracker:outbox:${uid}`,
      `bettracker:settings:${uid}`,
      `bettracker:settings-outbox:${uid}`,
      `bettracker:moves:${uid}`,
      `bettracker:moves-outbox:${uid}`,
      ...rowKeys,
      `bettracker:expense-last:${uid}`,
      'bettracker:last-user'
    ]
    // The exchange rates this device has fetched are no one's data (two currency codes, a date and a number): they stay.
    const kept = ['bettracker:theme', 'bettracker:lang', 'bettracker:view', 'bettracker:fx', 'e2e:rows', 'bettracker:cache:someone-else', 'bettracker:expenses:someone-else']
    for (const k of [...demoKeys, ...userKeys, ...kept]) localStorage.setItem(k, '1')

    resetDemo()

    for (const k of [...demoKeys, ...userKeys]) expect(localStorage.getItem(k), k).toBeNull()
    for (const k of kept) expect(localStorage.getItem(k), k).toBe('1')
  })
})
