import { beforeEach, describe, expect, it } from 'vitest'
import { DEMO_USER, demoHasData, resetDemo } from './demo'

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

describe('demoHasData', () => {
  const uid = DEMO_USER.id

  it('an empty demo holds nothing: no tables, empty tables, flags and device settings are not data', () => {
    expect(demoHasData()).toBe(false)
    for (const k of ['demo:rows', 'demo:moves', 'demo:expenses', 'demo:expense-cards', 'demo:expense-budgets', `bettracker:outbox:${uid}`]) localStorage.setItem(k, '[]')
    for (const k of ['demo:migrated', 'demo:migrated-008', 'demo:migrated-009', 'demo:signed-out', 'bettracker:theme', 'bettracker:view', 'bettracker:fx']) localStorage.setItem(k, '1')
    expect(demoHasData()).toBe(false)
  })

  it.each([
    ['a bet', 'demo:rows', '[{"id":"a"}]'],
    ['a deposit', 'demo:moves', '[{"id":"a"}]'],
    ['an expense', 'demo:expenses', '[{"id":"a"}]'],
    ['a card', 'demo:expense-cards', '[{"id":"a"}]'],
    ['a budget', 'demo:expense-budgets', '[{"id":"a"}]'],
    ['settings that were changed', 'demo:settings', '{"starting_bankroll":100}'],
    ['a bet still waiting to be sent', `bettracker:outbox:${uid}`, '[{"kind":"add"}]'],
    ['a deposit still waiting', `bettracker:moves-outbox:${uid}`, '[{"kind":"add"}]'],
    ['an expense still waiting', `bettracker:expenses-outbox:${uid}`, '[{"kind":"add"}]'],
    ['a card still waiting', `bettracker:expense-cards-outbox:${uid}`, '[{"kind":"add"}]'],
    ['a budget still waiting', `bettracker:expense-budgets-outbox:${uid}`, '[{"kind":"add"}]'],
    ['a settings change still waiting', `bettracker:settings-outbox:${uid}`, '{"patch":{}}']
  ])('%s is data', (_what, key, value) => {
    localStorage.setItem(key, value)
    expect(demoHasData()).toBe(true)
  })

  it('someone else’s data, and what can’t be read, are not the demo’s', () => {
    localStorage.setItem('e2e:rows', '[{"id":"a"}]')
    localStorage.setItem('bettracker:outbox:someone-else', '[{"kind":"add"}]')
    localStorage.setItem('demo:rows', '{not json')
    expect(demoHasData()).toBe(false)
  })
})
