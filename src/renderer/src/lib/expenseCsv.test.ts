import { describe, expect, it } from 'vitest'
import type { Expense, ExpenseCard } from '../../../shared/types'
import { parseCsv } from './csv'
import { EXPENSE_COLUMNS, expensesToCsv } from './expenseCsv'

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const GONE = 'dddddddd-0000-4000-8000-000000000004'
const CARDS: ExpenseCard[] = [{ id: A, name: 'Visa, "Oro"', last4: '0123', kind: 'credit', archived: true, createdAt: '2026-01-01', updatedAt: '2026-01-01' }]

const exp = (over: Partial<Expense> & { id: string; date: string; amount: number }): Expense => ({
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
    expect(csv.startsWith('﻿date,amount,currency,card,card_last4,merchant,category,note,source\r\n')).toBe(true)
    expect(csv.endsWith('\r\n')).toBe(true)
    expect(EXPENSE_COLUMNS).toHaveLength(9)
  })

  it('one row per expense, by date then creation; signed amounts to the cent; the card’s name and digits or nothing', () => {
    const rows = parseCsv(csv)
    expect(rows.slice(1, 4)).toEqual([
      ['2026-11-01', '1234.50', 'EUR', '', '', 'Hotel, Madrid', 'travel', "'+34 600", 'manual'],
      ['2026-11-03', '4.50', 'EUR', 'Visa, "Oro"', '0123', '\'=HYPERLINK("http://x")', 'coffee', '', 'manual'],
      ['2026-11-03', '-12.00', 'EUR', 'Visa, "Oro"', '0123', 'Zara', 'shopping', 'returned\na shirt', 'ai']
    ])
  })

  it('guards formulas and quotes commas, quotes and line breaks', () => {
    expect(csv).toContain(',"\'=HYPERLINK(""http://x"")",')
    expect(csv).toContain(',"Visa, ""Oro""",')
    expect(csv).toContain(',"returned\na shirt",')
    const formula = expensesToCsv([exp({ id: 'x', date: '2026-11-01', amount: 1, merchant: '@SUM(A1)', note: '-2+3' })], [{ ...CARDS[0], name: '=cmd' }], 'USD')
    expect(formula).toContain(",'@SUM(A1),other,'-2+3,")
  })

  it('an empty list is the header alone', () => {
    expect(expensesToCsv([], [], 'USD')).toBe('﻿date,amount,currency,card,card_last4,merchant,category,note,source\r\n')
  })
})
