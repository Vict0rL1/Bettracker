import { describe, expect, it } from 'vitest'
import { StorageWriteError } from '../data/store'
import { isFreeStake, oddsProblem, refusalText, resultProblem, stakeProblem } from './betForm'
import { normalizeInput } from './validate'

describe('the bet forms’ problems, in words', () => {
  it('the stake: required unless it may go unrecorded; 0 is a free bet, not a problem', () => {
    expect(stakeProblem('')?.key).toBe('field.stakeRequired')
    expect(stakeProblem('', true)).toBeNull()
    expect(stakeProblem('0')).toBeNull()
    expect(stakeProblem('-1')?.key).toBe('field.stakeInvalid')
    expect(stakeProblem('abc')?.key).toBe('field.stakeInvalid')
    expect(stakeProblem('100000001')?.key).toBe('field.tooBig')
  })

  it('the odds: empty is fine; anything else must be a price the database keeps, with an example in the user’s format', () => {
    expect(oddsProblem('', null, 'american')).toBeNull()
    expect(oddsProblem('+150', 2.5, 'american')).toBeNull()
    expect(oddsProblem('1.0004', 1.0004, 'decimal')).toMatchObject({ key: 'field.oddsInvalid', vars: { example: expect.any(String) } })
    expect(oddsProblem('x', null, 'fractional')?.key).toBe('field.oddsInvalid')
  })

  it('a result: more than $0.00 once rounded, and said apart when it rounds to 0', () => {
    expect(resultProblem('')?.key).toBe('field.resultRequired')
    expect(resultProblem('0')?.key).toBe('field.resultRequired')
    expect(resultProblem('0.004')?.key).toBe('field.resultRoundsZero')
    expect(resultProblem('-5')?.key).toBe('field.resultInvalid')
    expect(resultProblem('12.5')).toBeNull()
    // A lost free bet: nothing to type.
    expect(resultProblem('', true)).toBeNull()
  })

  it('a free bet is a stake that rounds to 0', () => {
    expect(isFreeStake(0)).toBe(true)
    expect(isFreeStake(0.004)).toBe(true)
    expect(isFreeStake(0.01)).toBe(false)
    expect(isFreeStake(null)).toBe(false)
  })
})

describe('refusalText', () => {
  const t = (key: string, vars?: Record<string, string | number>): string => `${key}${vars && Object.keys(vars).length > 0 ? JSON.stringify(vars) : ''}`

  it('a refused bet in the user’s words, by its code', () => {
    let err: unknown
    try {
      normalizeInput({ date: '2026-05-04', status: 'won', amount: 0 })
    } catch (e) {
      err = e
    }
    expect(refusalText(err, t as never)).toBe('invalid.wonPositive')
  })

  it('storage that refused, and anything else by its message', () => {
    expect(refusalText(new StorageWriteError(new Error('quota')), t as never)).toBe('toast.notSaved')
    expect(refusalText(new Error('No ids today'), t as never)).toBe('No ids today')
    expect(refusalText('?', t as never)).toBe('common.error')
  })
})
