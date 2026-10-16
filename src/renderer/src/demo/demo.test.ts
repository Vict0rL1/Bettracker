import { beforeEach, describe, expect, it } from 'vitest'
import { DEMO_USER, resetDemo } from './demo'

beforeEach(() => localStorage.clear())

describe('resetDemo', () => {
  it("empties the fake server and the demo user's copy on this device, and nothing else", () => {
    const uid = DEMO_USER.id
    const demoKeys = ['demo:rows', 'demo:moves', 'demo:settings', 'demo:signed-out', 'demo:migrated']
    const userKeys = [
      `bettracker:cache:${uid}`,
      `bettracker:outbox:${uid}`,
      `bettracker:settings:${uid}`,
      `bettracker:settings-outbox:${uid}`,
      `bettracker:moves:${uid}`,
      `bettracker:moves-outbox:${uid}`,
      'bettracker:last-user'
    ]
    const kept = ['bettracker:theme', 'bettracker:lang', 'e2e:rows', 'bettracker:cache:someone-else']
    for (const k of [...demoKeys, ...userKeys, ...kept]) localStorage.setItem(k, '1')

    resetDemo()

    for (const k of [...demoKeys, ...userKeys]) expect(localStorage.getItem(k), k).toBeNull()
    for (const k of kept) expect(localStorage.getItem(k), k).toBe('1')
  })
})
