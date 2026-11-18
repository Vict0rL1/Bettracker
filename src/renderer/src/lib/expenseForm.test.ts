import { describe, expect, it } from 'vitest'
import type { Expense, ExpenseCard } from '../../../shared/types'
import {
  budgetCommit,
  cardDeleteMode,
  draftOf,
  draftToInput,
  expenseAmountProblem,
  expenseDateProblem,
  formatAmountText,
  initialDraft,
  merchantLabel,
  parseAmountText,
  pasteIsTyping,
  resumedDraft
} from './expenseForm'
import { normalizeExpense } from './validate'

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const card = (id: string, archived = false): ExpenseCard => ({ id, name: id.slice(0, 4), last4: '', kind: 'credit', archived, createdAt: '2026-01-01', updatedAt: '2026-01-01' })
const expense = (over: Partial<Expense> = {}): Expense => ({
  id: 'e1',
  date: '2026-11-17',
  amount: 4.5,
  cardId: A,
  merchant: 'Café Central',
  category: 'coffee',
  note: 'with Ana',
  source: 'manual',
  createdAt: '2026-11-17T08:00:00Z',
  updatedAt: '2026-11-17T08:00:00Z',
  ...over
})

describe('parseAmountText: what a person typed, read the way they meant it', () => {
  it.each<[string, number, ReturnType<typeof parseAmountText>]>([
    ['4,50', 2, 4.5],
    ['1.234,50', 2, 1234.5],
    ['1,234.50', 2, 1234.5],
    ['12.500', 2, 12500],
    ['12.50', 2, 12.5],
    ['1.234.567', 2, 1234567],
    ['1,234,567.89', 2, 1234567.89],
    ['$ 4.50', 2, 4.5],
    ['COP 12.500', 2, 12500],
    ['MX$1,240', 2, 1240],
    ['€ 4,5', 2, 4.5],
    ['4.5', 0, 'noMinorUnits'],
    ['4,500', 0, 4500],
    ['12.500', 0, 12500],
    ['12500', 0, 12500],
    ['4.5055', 2, 4.51],
    ['1,234.505', 2, 1234.51],
    ['4.004', 2, 4004],
    ['0.004', 2, 0],
    ['0,500', 2, 0.5],
    ['.5', 2, 0.5],
    ['5.', 2, 5],
    ['1.500', 3, 1.5],
    ['abc', 2, 'invalid'],
    ['', 2, null],
    ['   ', 2, null],
    ['-4', 2, 'invalid'],
    ['4-', 2, 'invalid'],
    ['1.2.3', 2, 'invalid'],
    ['1,234.5.6', 2, 'invalid'],
    ['12,34.50', 2, 'invalid'],
    ['4/5', 2, 'invalid']
  ])('"%s" with %i digits → %s', (text, digits, expected) => {
    expect(parseAmountText(text, digits)).toBe(expected)
  })

  it.each<[string, ReturnType<typeof parseAmountText>]>([
    // A letter that isn't a currency mark is never dropped unseen: "12k" is not 12, "1e3" not 13, "1O.50" not 1.5.
    ['12k', 'invalid'],
    ['12K', 'invalid'],
    ['12 mil', 'invalid'],
    ['12 MIL', 'invalid'],
    ['1e3', 'invalid'],
    ['1E3', 'invalid'],
    ['1O.50', 'invalid'],
    ['4o', 'invalid'],
    ['$12k', 'invalid'],
    ['12 pesos', 'invalid'],
    // Spaces between digits only group thousands.
    ['4 50', 'invalid'],
    ['1 2', 'invalid'],
    // Currency marks before or after the number.
    ['US$ 4.50', 4.5],
    ['4.50 USD', 4.5],
    ['4.50 usd', 4.5],
    ['4,50 €', 4.5],
    ['4,50€', 4.5],
    ['$4.50 USD', 4.5],
    ['R$ 10,00', 10],
    ['$U 100', 100],
    ['RD$ 1.500', 1500],
    ['COP $ 12.500', 12500],
    ['Q 45.00', 45],
    ['Q45', 45],
    ['S/ 12.50', 12.5],
    ['S/. 12.50', 12.5],
    ['S/.12.50', 12.5],
    ['Bs.10', 10],
    ['$.50', 0.5],
    // Spaces (also the no-break ones Intl writes) grouping thousands; the separator after them is the decimal one.
    ['12 500', 12500],
    ['1 234,50', 1234.5],
    ['1\u202f234,500', 1234.5],
    ['1\u00a0234\u00a0567.89 €', 1234567.89]
  ])('"%s" with 2 digits → %s', (text, expected) => {
    expect(parseAmountText(text, 2)).toBe(expected)
  })

  it('a letter inside an amount is a problem in the amount box and a refused budget, never a smaller number', () => {
    for (const text of ['12k', '12 mil', '1e3', '1O.50']) {
      expect(expenseAmountProblem(text, 'USD'), text).toEqual({ key: 'field.resultInvalid' })
      expect(budgetCommit(text, null, 'USD'), text).toBe('revert')
    }
  })

  it('a currency without cents takes a fraction of zeros (as invoices print it) and drops it; real cents are still refused', () => {
    for (const [text, n] of [
      ['12.500,00', 12500],
      ['12,500.00', 12500],
      ['1.500.000,00', 1500000],
      ['12.00', 12],
      ['12,0', 12],
      ['COP 12.500,00', 12500],
      ['12 500,00', 12500]
    ] as const) {
      expect(parseAmountText(text, 0), text).toBe(n)
    }
    expect(parseAmountText('12.500,50', 0)).toBe('noMinorUnits')
    expect(parseAmountText('12.05', 0)).toBe('noMinorUnits')
    expect(parseAmountText('0,00', 0)).toBe(0)
  })
})

describe('formatAmountText', () => {
  it('writes the box text parseAmountText reads back unchanged', () => {
    for (const [n, currency] of [
      [4.5, 'USD'],
      [12500, 'USD'],
      [1234567.89, 'EUR'],
      [12500, 'CLP'],
      [0.01, 'USD'],
      [1.5, 'KWD']
    ] as const) {
      const text = formatAmountText(n, currency)
      expect(text).not.toMatch(/,/)
      expect(parseAmountText(text, currency === 'CLP' ? 0 : currency === 'KWD' ? 3 : 2), `${n} ${currency}`).toBe(n)
    }
    expect(formatAmountText(4.5, 'USD')).toBe('4.50')
    expect(formatAmountText(12500, 'CLP')).toBe('12500')
  })

  it('keeps cents a currency has no room for, so the box says so instead of rounding them away', () => {
    expect(formatAmountText(4.5, 'CLP')).toBe('4.50')
    expect(expenseAmountProblem(formatAmountText(4.5, 'CLP'), 'CLP')).toEqual({ key: 'field.noMinorUnits', vars: { currency: 'CLP' } })
  })
})

describe('expenseAmountProblem', () => {
  it('names what is wrong with the amount box', () => {
    expect(expenseAmountProblem('', 'USD')).toEqual({ key: 'field.resultRequired' })
    expect(expenseAmountProblem('0', 'USD')).toEqual({ key: 'field.resultRequired' })
    expect(expenseAmountProblem('abc', 'USD')).toEqual({ key: 'field.resultInvalid' })
    expect(expenseAmountProblem('-3', 'USD')).toEqual({ key: 'field.resultInvalid' })
    expect(expenseAmountProblem('4,5', 'CLP')).toEqual({ key: 'field.noMinorUnits', vars: { currency: 'CLP' } })
    expect(expenseAmountProblem('100000001', 'USD')).toEqual({ key: 'field.tooBig' })
    expect(expenseAmountProblem('0.004', 'USD')).toEqual({ key: 'field.resultRoundsZero' })
    expect(expenseAmountProblem('4,50', 'EUR')).toBeNull()
    expect(expenseAmountProblem('12.500', 'CLP')).toBeNull()
  })

  it('pesos: ",00" is fine in the amount box, cents are not', () => {
    for (const currency of ['COP', 'CLP']) {
      expect(expenseAmountProblem('12.500,00', currency), currency).toBeNull()
      expect(expenseAmountProblem('12,500.00', currency), currency).toBeNull()
      expect(expenseAmountProblem('12.500,50', currency), currency).toEqual({ key: 'field.noMinorUnits', vars: { currency } })
      expect(expenseAmountProblem('0,00', currency), currency).toEqual({ key: 'field.resultRequired' })
    }
  })

  it('and the date box', () => {
    expect(expenseDateProblem('2026-11-17')).toBeNull()
    expect(expenseDateProblem('2026-02-30')).toEqual({ key: 'field.dateInvalid' })
    expect(expenseDateProblem('')).toEqual({ key: 'field.dateInvalid' })
  })
})

describe('the sheet’s draft', () => {
  const cards = [card(A), card(B), card('cccccccc-0000-4000-8000-000000000003', true)]

  it('starts on today, the card asked for if it is active', () => {
    expect(initialDraft({ today: '2026-11-17', last: { cardId: A, category: 'food' }, cards, preferCardId: B })).toEqual({
      amount: '',
      refund: false,
      date: '2026-11-17',
      cardId: B,
      category: 'food',
      merchant: '',
      note: ''
    })
  })

  it('else the last card while it is active, else the only active card, else none', () => {
    expect(initialDraft({ today: '2026-11-17', last: { cardId: A, category: 'food' }, cards }).cardId).toBe(A)
    expect(initialDraft({ today: '2026-11-17', last: { cardId: A, category: 'food' }, cards, preferCardId: 'gone' }).cardId).toBe(A)
    const archivedLast = { cardId: 'cccccccc-0000-4000-8000-000000000003', category: 'food' as const }
    expect(initialDraft({ today: '2026-11-17', last: archivedLast, cards }).cardId).toBeNull()
    expect(initialDraft({ today: '2026-11-17', last: archivedLast, cards: [card(A), card(B, true)] }).cardId).toBe(A)
    expect(initialDraft({ today: '2026-11-17', last: null, cards: [card(A)] })).toMatchObject({ cardId: A, category: 'other' })
    expect(initialDraft({ today: '2026-11-17', last: null, cards: [] }).cardId).toBeNull()
  })

  it('back from "Add card": what was typed, with the card added chosen while it is active', () => {
    const typed = { amount: '4.50', refund: false, date: '2026-11-16', cardId: null, category: 'coffee' as const, merchant: 'Kiosk', note: 'n' }
    expect(resumedDraft(typed, cards, B)).toEqual({ ...typed, cardId: B })
    expect(resumedDraft({ ...typed, cardId: A }, cards, B)).toEqual({ ...typed, cardId: B })
    // No card added, an archived one or one this device doesn't know: the draft as it was.
    expect(resumedDraft({ ...typed, cardId: A }, cards, null)).toEqual({ ...typed, cardId: A })
    expect(resumedDraft(typed, cards, 'cccccccc-0000-4000-8000-000000000003')).toEqual(typed)
    expect(resumedDraft(typed, cards, 'gone')).toEqual(typed)
  })

  it('an expense in the boxes: a refund is the toggle and an unsigned amount', () => {
    expect(draftOf(expense({ amount: -12.5 }), 'USD')).toEqual({ amount: '12.50', refund: true, date: '2026-11-17', cardId: A, category: 'coffee', merchant: 'Café Central', note: 'with Ana' })
    expect(draftOf(expense({ amount: 12500 }), 'CLP')).toMatchObject({ amount: '12500', refund: false })
  })

  it('back to an input: the toggle sets the sign, and normalizeExpense takes it', () => {
    const d = { ...draftOf(expense(), 'EUR'), amount: '4,50' }
    expect(draftToInput(d, 'manual', 'EUR')).toEqual({ date: '2026-11-17', amount: 4.5, cardId: A, category: 'coffee', merchant: 'Café Central', note: 'with Ana', source: 'manual' })
    expect(draftToInput({ ...d, refund: true }, 'ai', 'EUR')).toMatchObject({ amount: -4.5, source: 'ai' })
    expect(normalizeExpense(draftToInput({ ...d, refund: true }, 'ai', 'EUR'))).toMatchObject({ amount: -4.5, source: 'ai' })
    // Never reached by the sheet (it checks first), but never a silent 0 either.
    expect(() => normalizeExpense(draftToInput({ ...d, amount: 'x' }, 'manual', 'EUR'))).toThrow()
  })

  it('merchantLabel: the merchant, or the words for none', () => {
    const t = () => 'No merchant'
    expect(merchantLabel('Uber', t)).toBe('Uber')
    expect(merchantLabel('  ', t)).toBe('No merchant')
  })
})

describe('pasteIsTyping', () => {
  const both = ['text/plain', 'text/html', 'Files']

  it('text pasted into a box that takes text is typing, a picture of the cells beside it or not', () => {
    expect(pasteIsTyping({ tagName: 'INPUT', type: 'text' }, both)).toBe(true)
    expect(pasteIsTyping({ tagName: 'input', type: 'search' }, both)).toBe(true)
    expect(pasteIsTyping({ tagName: 'INPUT' }, both)).toBe(true)
    expect(pasteIsTyping({ tagName: 'TEXTAREA' }, both)).toBe(true)
    expect(pasteIsTyping({ tagName: 'DIV', isContentEditable: true }, both)).toBe(true)
    expect(pasteIsTyping({ tagName: 'INPUT', type: 'text' }, ['text/plain'])).toBe(true)
  })

  it('an image with no text, or a paste anywhere else in the sheet, is left to the scan', () => {
    expect(pasteIsTyping({ tagName: 'INPUT', type: 'text' }, ['Files'])).toBe(false)
    expect(pasteIsTyping({ tagName: 'INPUT', type: 'text' }, ['text/html', 'Files'])).toBe(false)
    expect(pasteIsTyping({ tagName: 'DIV', isContentEditable: false }, both)).toBe(false)
    expect(pasteIsTyping({ tagName: 'BUTTON', type: 'button' }, both)).toBe(false)
    expect(pasteIsTyping({ tagName: 'INPUT', type: 'date' }, both)).toBe(false)
    expect(pasteIsTyping({ tagName: 'INPUT', type: 'checkbox' }, both)).toBe(false)
    expect(pasteIsTyping({ tagName: 'INPUT', type: 'text', readOnly: true }, both)).toBe(false)
    expect(pasteIsTyping({ tagName: 'INPUT', type: 'text', disabled: true }, both)).toBe(false)
    expect(pasteIsTyping(null, both)).toBe(false)
  })
})

describe('cardDeleteMode', () => {
  const c = card(A)
  it('deletes only when the expenses are known for sure and none uses the card', () => {
    expect(cardDeleteMode(c, [], { loaded: false, readThisSession: false })).toBe('archive')
    expect(cardDeleteMode(c, [], { loaded: true, readThisSession: false })).toBe('archive')
    expect(cardDeleteMode(c, [expense({ cardId: B })], { loaded: true, readThisSession: true })).toBe('delete')
    expect(cardDeleteMode(c, [expense({ cardId: A })], { loaded: true, readThisSession: true })).toBe('archive')
    expect(cardDeleteMode(c, [expense({ cardId: A.toUpperCase() })], { loaded: true, readThisSession: true })).toBe('archive')
  })
})

describe('budgetCommit', () => {
  it('nothing to do when the box holds no edit, or the same cents', () => {
    expect(budgetCommit(null, 100, 'USD')).toBeNull()
    expect(budgetCommit('100', 100, 'USD')).toBeNull()
    expect(budgetCommit('100,00', 100, 'USD')).toBeNull()
    // One separator and 3 digits is a thousands group: 100.001 is a new limit.
    expect(budgetCommit('100.001', 100, 'USD')).toEqual({ limit: 100001 })
  })

  it('a cleared box (or 0) clears a limit, and is nothing without one', () => {
    expect(budgetCommit('', 100, 'USD')).toEqual({ limit: null })
    expect(budgetCommit('', null, 'USD')).toBeNull()
    expect(budgetCommit('0', 100, 'USD')).toEqual({ limit: null })
    expect(budgetCommit('0', null, 'USD')).toBeNull()
  })

  it('refused text goes back to the saved value', () => {
    expect(budgetCommit('x', 100, 'USD')).toBe('revert')
    expect(budgetCommit('4.5', null, 'CLP')).toBe('revert')
    expect(budgetCommit('200000000', null, 'USD')).toBe('revert')
  })

  it('a new limit, read as typed', () => {
    expect(budgetCommit('1.234,5', 100, 'EUR')).toEqual({ limit: 1234.5 })
    expect(budgetCommit('250', null, 'USD')).toEqual({ limit: 250 })
    expect(budgetCommit('12.500', null, 'CLP')).toEqual({ limit: 12500 })
  })

  it('pesos: a limit typed with ",00" is taken; one with cents goes back', () => {
    expect(budgetCommit('1.500.000,00', null, 'COP')).toEqual({ limit: 1500000 })
    expect(budgetCommit('1,500,000.00', 1500000, 'CLP')).toBeNull()
    expect(budgetCommit('1.500.000,50', null, 'COP')).toBe('revert')
  })
})
