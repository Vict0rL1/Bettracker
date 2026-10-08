import { describe, expect, it } from 'vitest'
import { formatOdds, fromAmerican, fromFractional, parseOdds, toAmerican, toFractional } from './odds'

describe('american', () => {
  it('converts both ways at the common prices', () => {
    expect(toAmerican(2.5)).toBe(150)
    expect(toAmerican(2)).toBe(100)
    expect(toAmerican(1.9091)).toBe(-110)
    expect(toAmerican(1.5)).toBe(-200)
    expect(fromAmerican(150)).toBeCloseTo(2.5)
    expect(fromAmerican(-110)).toBeCloseTo(1.9091, 3)
    expect(fromAmerican(100)).toBe(2)
    expect(fromAmerican(-100)).toBe(2)
  })

  it('has no prices between -100 and +100', () => {
    expect(fromAmerican(50)).toBeNull()
    expect(fromAmerican(-99)).toBeNull()
    expect(fromAmerican(0)).toBeNull()
  })
})

describe('fractional', () => {
  it('finds the familiar fraction for a decimal price', () => {
    expect(toFractional(2.5)).toBe('3/2')
    expect(toFractional(2)).toBe('1/1')
    expect(toFractional(1.5)).toBe('1/2')
    expect(toFractional(1.9091)).toBe('10/11')
    expect(toFractional(1.8333)).toBe('5/6')
    expect(toFractional(11)).toBe('10/1')
  })

  it('reads a fraction, with the separators people type', () => {
    expect(fromFractional('3/2')).toBe(2.5)
    expect(fromFractional('5-6')).toBeCloseTo(1.8333, 3)
    expect(fromFractional(' 10 : 11 ')).toBeCloseTo(1.9091, 3)
    expect(fromFractional('x/2')).toBeNull()
    expect(fromFractional('3/0')).toBeNull()
  })
})

describe('formatOdds', () => {
  it('shows a stored decimal in each format', () => {
    expect(formatOdds(2.5, 'american')).toBe('+150')
    expect(formatOdds(1.9091, 'american')).toBe('-110')
    expect(formatOdds(2.5, 'decimal')).toBe('2.50')
    expect(formatOdds(2.5, 'fractional')).toBe('3/2')
  })
})

describe('parseOdds', () => {
  it('understands a fraction or a signed American price whatever the setting', () => {
    for (const f of ['american', 'decimal', 'fractional'] as const) {
      expect(parseOdds('3/2', f)).toBe(2.5)
      expect(parseOdds('+150', f)).toBe(2.5)
      expect(parseOdds('-120', f)).toBeCloseTo(1.8333, 3)
    }
  })

  it('reads a bare number by the setting', () => {
    expect(parseOdds('150', 'american')).toBe(2.5)
    expect(parseOdds('150', 'decimal')).toBe(150)
    expect(parseOdds('1.91', 'american')).toBe(1.91)
    expect(parseOdds('2,50', 'decimal')).toBe(2.5)
    expect(parseOdds('1.91', 'fractional')).toBe(1.91)
  })

  it('rejects what is not a price', () => {
    expect(parseOdds('', 'decimal')).toBeNull()
    expect(parseOdds('abc', 'decimal')).toBeNull()
    expect(parseOdds('1', 'decimal')).toBeNull()
    expect(parseOdds('0.5', 'decimal')).toBeNull()
    expect(parseOdds('+50', 'american')).toBeNull()
  })
})
