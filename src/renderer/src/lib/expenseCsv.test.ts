import { describe, expect, it } from 'vitest'
import type { Expense, ExpenseCard } from '../../../shared/types'
import { parseCsv } from './csv'
import { EXPENSE_COLUMNS, expensesToCsv } from './expenseCsv'

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const GONE = 'dddddddd-0000-4000-8000-000000000004'
const CARDS: ExpenseCard[] = [{ id: A, name: 'Visa, "Oro"', last4: '0123', kind: 'credit', archived: true, createdAt: '2026-01-01', updatedAt: '2026-01-01' }]

const exp = (over: Partial<Expense> & { id: string; date: string; amount: number }): Expense => ({
  originalAmount: null,
  originalCurrency: null,
  fxRate: null,
  cardId: null,
  merchant: '',
  category: 'other',
  note: '',
  source: 'manual',
  createdAt: `${over.date}T10:00:00Z`,
  updatedAt: `${over.date}T10:00:00Z`,
  ...over
})

describe('expensesToCsv', () => {
  const list = [
    exp({ id: 'b', date: '2026-11-03', amount: -12, cardId: A, merchant: 'Zara', category: 'shopping', note: 'returned\na shirt', source: 'ai', createdAt: '2026-11-03T12:00:00Z' }),
    exp({ id: 'a', date: '2026-11-03', amount: 4.5, cardId: A, merchant: '=HYPERLINK("http://x")', category: 'coffee', createdAt: '2026-11-03T08:00:00Z' }),
    exp({ id: 'c', date: '2026-11-01', amount: 1234.5, cardId: GONE, merchant: 'Hotel, Madrid', category: 'travel', note: '+34 600' })
  ]
  const csv = expensesToCsv(list, CARDS, 'EUR')

  it('starts with a BOM and the header, and ends lines with CRLF', () => {
    expect(csv.startsWith('﻿date,amount,currency,card,card_last4,merchant,category,note,source,original_amount,original_currency,fx_rate\r\n')).toBe(true)
    expect(csv.endsWith('\r\n')).toBe(true)
    // The three of migration 009 come last: the first nine are where a sheet made before expects them.
    expect(EXPENSE_COLUMNS.slice(0, 9)).toEqual(['date', 'amount', 'currency', 'card', 'card_last4', 'merchant', 'category', 'note', 'source'])
    expect(EXPENSE_COLUMNS.slice(9)).toEqual(['original_amount', 'original_currency', 'fx_rate'])
  })

  it('one row per expense, by date then creation; signed amounts to the cent; the card’s name and digits or nothing', () => {
    const rows = parseCsv(csv)
    expect(rows.slice(1, 4)).toEqual([
      ['2026-11-01', '1234.50', 'EUR', '', '', 'Hotel, Madrid', 'travel', "'+34 600", 'manual', '', '', ''],
      ['2026-11-03', '4.50', 'EUR', 'Visa, "Oro"', '0123', '\'=HYPERLINK("http://x")', 'coffee', '', 'manual', '', '', ''],
      ['2026-11-03', '-12.00', 'EUR', 'Visa, "Oro"', '0123', 'Zara', 'shopping', 'returned\na shirt', 'ai', '', '', '']
    ])
  })

  it('an expense paid in another currency also says what was paid, in what, and the rate (three columns at the end)', () => {
    const rows = parseCsv(
      expensesToCsv(
        [
          exp({ id: 'u', date: '2026-11-13', amount: 16.84, merchant: 'Apple.com', originalAmount: 12, originalCurrency: 'USD', fxRate: 1.4034 }),
          exp({ id: 'r', date: '2026-11-14', amount: -7.02, merchant: 'Refund', originalAmount: -5, originalCurrency: 'USD', fxRate: 1.40341235 }),
          exp({ id: 'c', date: '2026-11-15', amount: 4.27, merchant: 'Bogotá', originalAmount: 12500, originalCurrency: 'COP', fxRate: 0.00034123 }),
          exp({ id: 'w', date: '2026-11-16', amount: 24, merchant: 'Whole', originalAmount: 12, originalCurrency: 'GBP', fxRate: 2 }),
          exp({ id: 'm', date: '2026-11-17', amount: 9.99, merchant: 'Local' })
        ],
        [],
        'CAD'
      )
    )
    expect(rows[0]).toEqual([...EXPENSE_COLUMNS])
    expect(rows.slice(1).map((r) => [r[1], r[2], r[9], r[10], r[11]])).toEqual([
      ['16.84', 'CAD', '12.00', 'USD', '1.4034'],
      ['-7.02', 'CAD', '-5.00', 'USD', '1.40341235'],
      ['4.27', 'CAD', '12500.00', 'COP', '0.00034123'],
      ['24.00', 'CAD', '12.00', 'GBP', '2'],
      ['9.99', 'CAD', '', '', '']
    ])
    for (const r of rows.slice(1)) expect(r).toHaveLength(EXPENSE_COLUMNS.length)
  })

  it('guards formulas and quotes commas, quotes and line breaks', () => {
    expect(csv).toContain(',"\'=HYPERLINK(""http://x"")",')
    expect(csv).toContain(',"Visa, ""Oro""",')
    expect(csv).toContain(',"returned\na shirt",')
    const formula = expensesToCsv([exp({ id: 'x', date: '2026-11-01', amount: 1, merchant: '@SUM(A1)', note: '-2+3' })], [{ ...CARDS[0], name: '=cmd' }], 'USD')
    expect(formula).toContain(",'@SUM(A1),other,'-2+3,")
    // A code is three capital letters when the app wrote it; one that isn't (a cache edited by hand) is still guarded.
    expect(expensesToCsv([exp({ id: 'x', date: '2026-11-01', amount: 1, originalAmount: 1, originalCurrency: '=A1', fxRate: 1 })], [], 'USD')).toContain(",1.00,'=A1,1\r\n")
  })

  it('an empty list is the header alone', () => {
    expect(expensesToCsv([], [], 'USD')).toBe('﻿date,amount,currency,card,card_last4,merchant,category,note,source,original_amount,original_currency,fx_rate\r\n')
  })
})
