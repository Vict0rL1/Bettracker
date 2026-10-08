import { beforeEach, describe, expect, it } from 'vitest'
import { en, es } from './strings'
import { getLang, setLang, t, tn } from './i18n'

beforeEach(() => setLang('en'))

describe('dictionaries', () => {
  it('have exactly the same keys', () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort())
  })

  it('use the same placeholders in both languages', () => {
    const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort()
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(holes(es[key]), `placeholders of ${key}`).toEqual(holes(en[key]))
    }
  })

  it('leave no empty strings', () => {
    for (const d of [en, es]) for (const v of Object.values(d)) expect(v.trim()).not.toBe('')
  })
})

describe('t', () => {
  it('fills placeholders and leaves unknown ones visible', () => {
    expect(t('toast.settled', { status: 'won' })).toBe('Settled as won')
    expect(t('hist.pager', { from: 1, to: 25, total: 79 })).toBe('1–25 of 79')
    expect(t('toast.settled')).toBe('Settled as {status}')
  })

  it('switches language and persists the choice', () => {
    setLang('es')
    expect(getLang()).toBe('es')
    expect(t('hist.title')).toBe('Historial')
    expect(localStorage.getItem('bettracker:lang')).toBe('es')
  })
})

describe('tn', () => {
  it('picks one or other by count', () => {
    expect(tn('bet', 1)).toBe('1 bet')
    expect(tn('bet', 0)).toBe('0 bets')
    expect(tn('day', 12)).toBe('12 days')
    setLang('es')
    expect(tn('bet', 1)).toBe('1 apuesta')
    expect(tn('freeBet', 2)).toBe('2 apuestas gratis')
  })
})
