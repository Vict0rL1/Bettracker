import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as deployed from './compat/expenseExtraction-2026-11-18'
import { normalizeExtraction } from './expenseExtraction'

/**
 * An app installed before the per-expense currency keeps running against the
 * function deployed after it (a PWA updates on its next load, an Electron
 * build when it is reinstalled). That app checks every answer with its own
 * normalizeExtraction, so what the new function sends must still pass it.
 * compat/expenseExtraction-2026-11-18.ts is that module, frozen as it was
 * (commit 9159c37): never edited, never imported by the app or the function.
 */

const CTX = { today: '2026-11-17', lang: 'en' as const }

const row = (over: Record<string, unknown>): Record<string, unknown> => ({
  date: '2026-11-16',
  amount: 12,
  currencyBasis: 'code',
  currency: 'USD',
  chargedAmount: null,
  chargedCurrency: null,
  merchant: 'Blue Bottle Coffee',
  category: 'coffee',
  cardLast4: null,
  cardHint: null,
  note: '',
  pending: false,
  confidence: 'high',
  ...over
})

/** What the new function answers: the model's answer through the new normalizer, as `{ ok: true, ...result }`. */
const answered = (rows: Record<string, unknown>[]): Record<string, unknown> => {
  const result = normalizeExtraction({ kind: 'wallet', currency: null, expenses: rows, warnings: [] }, CTX)
  if (result === null) throw new Error('not an answer')
  return { ok: true, ...result }
}

describe('an app from before the per-expense currency, with the new function', () => {
  it('is the module as it was, byte for byte', () => {
    const hash = createHash('sha256').update(readFileSync(new URL('./compat/expenseExtraction-2026-11-18.ts', import.meta.url))).digest('hex').slice(0, 16)
    expect(hash).toBe('6ba1b12e9a415e23')
  })

  it('takes an answer with rows in two currencies and a charged amount: the rows as they were, the new fields ignored, no currency for the picture', () => {
    const data = answered([row({}), row({ amount: 5.25, currency: 'CAD', merchant: 'Tim Hortons' }), row({ amount: 20, chargedAmount: 27.4, chargedCurrency: 'CAD', merchant: 'Amazon.com' })])
    const old = deployed.normalizeExtraction(data, CTX)
    expect(old).not.toBeNull()
    // Two currencies: the picture has none, so that app reads every row in the main one (what it did with a bare "$").
    expect(old?.currency).toBeNull()
    expect(old?.expenses.map((e) => [e.merchant, e.amount])).toEqual([
      ['Blue Bottle Coffee', 12],
      ['Tim Hortons', 5.25],
      ['Amazon.com', 20]
    ])
    for (const e of old?.expenses ?? []) {
      expect(Object.keys(e).sort()).toEqual(['amount', 'cardHint', 'cardLast4', 'category', 'confidence', 'date', 'merchant', 'note', 'pending'])
    }
    expect(old?.warnings).toEqual([])
  })

  it('takes an answer whose rows are all in one currency as a picture in that currency, as before', () => {
    const old = deployed.normalizeExtraction(answered([row({}), row({ amount: 3, currencyBasis: 'place' })]), CTX)
    expect(old?.currency).toBe('USD')
    expect(old?.expenses).toHaveLength(2)
  })

  it('takes a reading where nothing settles the currency as before: no currency', () => {
    const old = deployed.normalizeExtraction(answered([row({ currencyBasis: 'none', currency: null })]), CTX)
    expect(old?.currency).toBeNull()
    expect(old?.expenses).toHaveLength(1)
  })
})
