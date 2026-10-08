import { describe, expect, it } from 'vitest'
import { bet } from '../test-utils'
import { openBets } from './pending'

describe('openBets', () => {
  it('keeps only pending bets, oldest first', () => {
    const list = openBets(
      [
        bet({ id: 'won', date: '2026-01-01', amount: 5 }),
        bet({ id: 'late', date: '2026-03-01', status: 'pending', amount: null }),
        bet({ id: 'early', date: '2026-02-01', status: 'pending', amount: null })
      ],
      '2026-02-15'
    )
    expect(list.map((o) => o.bet.id)).toEqual(['early', 'late'])
  })

  it('flags a date that has passed; today itself is not past', () => {
    const list = openBets(
      [
        bet({ id: 'y', date: '2026-02-14', status: 'pending', amount: null }),
        bet({ id: 't', date: '2026-02-15', status: 'pending', amount: null }),
        bet({ id: 'n', date: '2026-02-16', status: 'pending', amount: null })
      ],
      '2026-02-15'
    )
    expect(list.map((o) => [o.bet.id, o.past])).toEqual([
      ['y', true],
      ['t', false],
      ['n', false]
    ])
  })

  it('orders a day by when each bet was logged', () => {
    const list = openBets(
      [
        bet({ id: 'second', date: '2026-02-01', status: 'pending', amount: null, createdAt: '2026-02-01T12:00:00Z' }),
        bet({ id: 'first', date: '2026-02-01', status: 'pending', amount: null, createdAt: '2026-02-01T09:00:00Z' })
      ],
      '2026-02-01'
    )
    expect(list.map((o) => o.bet.id)).toEqual(['first', 'second'])
  })

  it('is empty when nothing is pending', () => {
    expect(openBets([bet({ amount: 1 })], '2026-01-01')).toEqual([])
  })
})
