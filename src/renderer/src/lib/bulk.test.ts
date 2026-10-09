import { describe, expect, it } from 'vitest'
import { bet } from '../test-utils'
import { retagPlan, settlePlan, toInput } from './bulk'

describe('toInput', () => {
  it('carries every editable field, closing odds included', () => {
    const b = bet({ amount: 150, stake: 100, odds: 2.5, closingOdds: 2.2, note: 'n', sport: 'NBA', book: 'DK', betType: 'ML' })
    expect(toInput(b)).toEqual({
      date: b.date,
      amount: 150,
      stake: 100,
      odds: 2.5,
      closingOdds: 2.2,
      status: 'won',
      note: 'n',
      sport: 'NBA',
      book: 'DK',
      betType: 'ML'
    })
  })
})

describe('retagPlan', () => {
  const a = bet({ id: 'a', amount: 1, sport: 'NBA', book: 'DK', betType: 'ML' })
  const b = bet({ id: 'b', amount: 1, sport: 'NFL', book: 'DK', betType: 'ML' })

  it('sets only the tags given and leaves the others as they were', () => {
    const plan = retagPlan([a, b], { sport: 'Tennis' })
    expect(plan.next.map((c) => [c.id, c.input.sport, c.input.book])).toEqual([
      ['a', 'Tennis', 'DK'],
      ['b', 'Tennis', 'DK']
    ])
  })

  it('skips bets the patch would not change, and keeps their reverse out too', () => {
    const plan = retagPlan([a, b], { sport: 'NBA' })
    expect(plan.next.map((c) => c.id)).toEqual(['b'])
    expect(plan.prev).toEqual([{ id: 'b', input: toInput(b) }])
  })

  it('can clear a tag with an empty string', () => {
    expect(retagPlan([a], { book: '' }).next[0].input.book).toBe('')
  })
})

describe('settlePlan', () => {
  const withOdds = bet({ id: 'p1', status: 'pending', stake: 50, odds: 2 })
  const noOdds = bet({ id: 'p2', status: 'pending', stake: 20 })
  const settled = bet({ id: 's', amount: 10, stake: 10 })

  it('settles only pending bets, with the amount the stake and odds imply', () => {
    const plan = settlePlan([withOdds, noOdds, settled], 'lost')
    expect(plan.next.map((c) => [c.id, c.input.status, c.input.amount])).toEqual([
      ['p1', 'lost', -50],
      ['p2', 'lost', -20]
    ])
    expect(plan.skipped).toBe(0)
    expect(plan.prev.every((c) => c.input.status === 'pending' && c.input.amount === null)).toBe(true)
  })

  it('skips a win whose profit cannot be worked out', () => {
    const plan = settlePlan([withOdds, noOdds], 'won')
    expect(plan.next.map((c) => [c.id, c.input.amount])).toEqual([['p1', 50]])
    expect(plan.skipped).toBe(1)
  })

  it('a push or void needs nothing', () => {
    const plan = settlePlan([noOdds], 'void')
    expect(plan.next[0].input).toMatchObject({ status: 'void', amount: 0 })
  })
})
