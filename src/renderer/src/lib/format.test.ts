import { describe, expect, it } from 'vitest'
import {
  axisMoney,
  fmtMoney,
  fmtMoneyCompact,
  fmtMoneyPlain,
  fmtOdds,
  fmtPct,
  fmtPct1,
  fmtPctSigned,
  fmtProb,
  fmtStake,
  moneyFormat,
  scaledFormat,
  type MoneyFormat
} from './format'

const METHODS = ['signed', 'plain', 'compact', 'axis', 'stake', 'bankroll'] as const

// A spread of dollar amounts across every formatter's tiers and edges.
const SAMPLE = [-123456.789, -150000, -2180, -1400, -1000, -999.99, -45, -12.345, -0.5, -0.004, 0, 0.004, 0.5, 12.345, 45, 120, 999.99, 1000, 1234.56, 99999, 150000]

describe('the dollar formatters (unchanged by units)', () => {
  it('read exactly as before', () => {
    expect(fmtMoney(1234.56)).toBe('+$1,234.56')
    expect(fmtMoney(-45)).toBe('-$45.00')
    expect(fmtMoney(0)).toBe('$0.00')
    expect(fmtMoneyPlain(1234.56)).toBe('$1,234.56')
    expect(fmtMoneyPlain(-45)).toBe('-$45.00')
    expect(fmtMoneyCompact(120)).toBe('+$120')
    expect(fmtMoneyCompact(-335)).toBe('-$335')
    expect(fmtMoneyCompact(-1400)).toBe('-$1.4k')
    expect(fmtMoneyCompact(1000)).toBe('+$1k')
    expect(fmtMoneyCompact(150000)).toBe('+$150k')
    expect(fmtMoneyCompact(0)).toBe('$0')
    expect(axisMoney(-5)).toBe('-$5')
    expect(axisMoney(1200)).toBe('$1.2k')
    expect(axisMoney(2000)).toBe('$2k')
    expect(axisMoney(0)).toBe('$0')
    expect(fmtPct(52.4)).toBe('52%')
    expect(fmtPctSigned(4.21)).toBe('+4.2%')
    expect(fmtPctSigned(-3)).toBe('-3.0%')
    expect(fmtPctSigned(0)).toBe('0.0%')
    expect(fmtStake(1240.4)).toBe('$1,240')
    expect(fmtStake(45)).toBe('$45.00')
    expect(fmtStake(999.99)).toBe('$999.99')
    expect(fmtOdds(2.5)).toBe('2.50')
    expect(fmtProb(52.4)).toBe('52%')
  })
})

describe('fmtPct1', () => {
  it('shows one decimal in en-US digits', () => {
    expect(fmtPct1(4.2)).toBe('4.2%')
    expect(fmtPct1(5)).toBe('5.0%')
    expect(fmtPct1(150)).toBe('150.0%')
    expect(fmtPct1(1250)).toBe('1,250.0%')
  })

  it('never reads -0.0%', () => {
    expect(fmtPct1(-0.04)).toBe('0.0%')
    expect(fmtPct1(-0.05)).toBe('-0.1%')
  })
})

describe('moneyFormat in dollars', () => {
  const m = moneyFormat(null)

  it('is the legacy formatters, on every value', () => {
    expect(m.unit).toBeNull()
    for (const n of SAMPLE) {
      expect(m.scale(n)).toBe(n)
      expect(m.signed(n)).toBe(fmtMoney(n))
      expect(m.plain(n)).toBe(fmtMoneyPlain(n))
      expect(m.compact(n)).toBe(fmtMoneyCompact(n))
      expect(m.axis(n)).toBe(axisMoney(n))
      expect(m.stake(n)).toBe(fmtStake(n))
    }
  })

  it('shows a bankroll below zero the way it shows one above', () => {
    expect(m.bankroll(2180)).toBe('$2,180')
    expect(m.bankroll(-2180)).toBe('-$2,180')
    expect(m.bankroll(-45.5)).toBe('-$45.50')
    expect(m.bankroll(0)).toBe('$0.00')
    for (const n of SAMPLE.filter((x) => Math.abs(x) >= 0.005)) expect(m.bankroll(n)).toBe((n < 0 ? '-' : '') + fmtStake(Math.abs(n)))
    // A bankroll that rounds to nothing carries no sign.
    expect(m.bankroll(-0.004)).toBe('$0.00')
  })

  it('falls back to dollars for a unit that is not a positive number', () => {
    for (const unit of [0, -20, Number.NaN, Number.POSITIVE_INFINITY]) {
      const f = moneyFormat(unit)
      expect(f.unit).toBeNull()
      expect(f.signed(47)).toBe('+$47.00')
    }
  })
})

describe('moneyFormat in units', () => {
  const u = moneyFormat(1)

  it('takes dollars and divides by the unit itself', () => {
    const m = moneyFormat(20)
    expect(m.unit).toBe(20)
    expect(m.scale(110)).toBe(5.5)
    expect(m.stake(110)).toBe('5.5u')
    expect(m.signed(47)).toBe('+2.35u')
    expect(m.plain(-60)).toBe('-3.00u')
    expect(m.bankroll(2180)).toBe('109u')
    expect(m.bankroll(-2180)).toBe('-109u')
    expect(m.compact(24000)).toBe('+1.2ku')
    expect(m.axis(30)).toBe('1.5u')
  })

  it('signed: two decimals, + above zero', () => {
    expect(u.signed(2.35)).toBe('+2.35u')
    expect(u.signed(-1)).toBe('-1.00u')
    expect(u.signed(0)).toBe('0.00u')
    expect(u.signed(1234.5)).toBe('+1,234.50u')
  })

  it('plain: two decimals, natural minus', () => {
    expect(u.plain(3)).toBe('3.00u')
    expect(u.plain(-3)).toBe('-3.00u')
  })

  it('stake: up to two decimals, no trailing zeros, thousands separated', () => {
    expect(u.stake(1)).toBe('1u')
    expect(u.stake(2.5)).toBe('2.5u')
    expect(u.stake(0.75)).toBe('0.75u')
    expect(u.stake(1.333)).toBe('1.33u')
    expect(u.stake(1250)).toBe('1,250u')
  })

  it('bankroll: the stake format with a natural minus', () => {
    expect(u.bankroll(109)).toBe('109u')
    expect(u.bankroll(-109)).toBe('-109u')
    expect(u.bankroll(-2.5)).toBe('-2.5u')
  })

  it('compact: a decimal under 10, whole to 999, then k; each tier picked once rounded', () => {
    expect(u.compact(2.3)).toBe('+2.3u')
    expect(u.compact(2)).toBe('+2u')
    expect(u.compact(2.04)).toBe('+2u')
    expect(u.compact(12)).toBe('+12u')
    expect(u.compact(12.6)).toBe('+13u')
    expect(u.compact(-150)).toBe('-150u')
    expect(u.compact(1200)).toBe('+1.2ku')
    expect(u.compact(1000)).toBe('+1ku')
    expect(u.compact(9.96)).toBe('+10u')
    expect(u.compact(999.6)).toBe('+1ku')
    expect(u.compact(0)).toBe('0u')
  })

  it('axis: natural minus, up to two decimals, then k like axisMoney', () => {
    expect(u.axis(1.5)).toBe('1.5u')
    expect(u.axis(-5)).toBe('-5u')
    expect(u.axis(0.25)).toBe('0.25u')
    expect(u.axis(0)).toBe('0u')
    expect(u.axis(1200)).toBe('1.2ku')
    expect(u.axis(-2000)).toBe('-2ku')
    expect(u.axis(999.996)).toBe('1ku')
  })

  it('never reads -0: the sign goes on the rounded figure', () => {
    expect(u.signed(-0.001)).toBe('0.00u')
    expect(u.plain(-0.004)).toBe('0.00u')
    expect(u.compact(-0.04)).toBe('0u')
    for (const n of [-0.001, -0.0049, -0.004, -0.04, -0.049, -1e-12]) {
      for (const k of METHODS) expect(u[k](n)).not.toMatch(/^-0(\.0*)?k?u$/)
    }
  })
})

describe('scaledFormat — figures already in what is shown', () => {
  it('in units, formats without dividing again', () => {
    const s = scaledFormat(true)
    const u: MoneyFormat = moneyFormat(1)
    expect(s.stake(5.5)).toBe('5.5u')
    for (const n of SAMPLE) for (const k of METHODS) expect(s[k](n)).toBe(u[k](n))
  })

  it('in dollars, is the dollar set', () => {
    const s = scaledFormat(false)
    const d = moneyFormat(null)
    for (const n of SAMPLE) for (const k of METHODS) expect(s[k](n)).toBe(d[k](n))
  })
})
