import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type BankrollMove, type Expense, type ExpenseBudget, type ExpenseCard } from '../../../shared/types'
import { bet } from '../test-utils'
import { BACKUP_VERSION, expensesHeld, makeBackup, planRestore, readBackup, settingsChange, type Backup } from './backup'

const ME = '11111111-2222-4333-8444-555555555555'
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const move = (n: number, amount: number): BankrollMove => ({ id: id(100 + n), date: '2026-08-01', amount, note: '', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' })
const settings = { ...DEFAULT_SETTINGS, startingBankroll: 1000, oddsFormat: 'decimal' as const }

const bets = [bet({ id: id(1), date: '2026-08-01', amount: 20, stake: 10, odds: 3 }), bet({ id: id(2), date: '2026-08-02', amount: -10, stake: 10 }), bet({ id: id(3), date: '2026-08-03', status: 'pending', stake: 5 })]
const backup = makeBackup(bets, [move(1, 500)], settings, { id: ME, email: 'me@example.com' }, new Date('2026-10-20T09:00:00Z'))
const text = JSON.stringify(backup)

const CARD_A = id(201)
const CARD_B = id(202)
const stamp = (n: number): string => `2026-11-0${n}T10:00:00.000Z`
const expense = (n: number, over: Partial<Expense> = {}): Expense => ({
  id: id(300 + n),
  date: '2026-11-10',
  amount: 4.5,
  cardId: CARD_A,
  merchant: 'Café Central',
  category: 'coffee',
  note: '',
  source: 'manual',
  createdAt: stamp(1),
  updatedAt: stamp(1),
  ...over
})
const card = (cid: string, n: number, over: Partial<ExpenseCard> = {}): ExpenseCard => ({ id: cid, name: `Card ${n}`, last4: '1234', kind: 'credit', archived: false, createdAt: stamp(n), updatedAt: stamp(n), ...over })
const budget = (n: number, over: Partial<ExpenseBudget> = {}): ExpenseBudget => ({ id: id(400 + n), scope: 'total', target: '', monthlyLimit: 600, createdAt: stamp(n), updatedAt: stamp(n), ...over })
const extras = {
  // Out of order on purpose: the file sorts them.
  expenses: [expense(3, { date: '2026-11-12' }), expense(2, { createdAt: stamp(2) }), expense(1, { amount: -12, category: 'shopping', cardId: null, source: 'ai' })],
  expenseCards: [card(CARD_B, 3, { kind: 'debit', last4: '' }), card(CARD_A, 1, { archived: true })],
  expenseBudgets: [budget(2, { scope: 'category', target: 'coffee', monthlyLimit: 35 }), budget(1)]
}
const full = makeBackup(bets, [move(1, 500)], { ...settings, expenseCurrency: 'EUR' }, { id: ME, email: 'me@example.com' }, new Date('2026-11-18T09:00:00Z'), extras)

describe('makeBackup', () => {
  it('writes the expenses’ currency with the other settings', () => {
    const made = makeBackup(bets, [], { ...settings, expenseCurrency: 'EUR' }, { id: ME, email: null })
    expect(made.settings.expenseCurrency).toBe('EUR')
    expect('updatedAt' in made.settings).toBe(false)
  })

  it('writes the expenses, cards and budgets when given, sorted, and no such keys when not', () => {
    expect(full.version).toBe(1)
    expect(full.expenses?.map((e) => e.id)).toEqual([id(301), id(302), id(303)])
    expect(full.expenseCards?.map((c) => c.id)).toEqual([CARD_A, CARD_B])
    expect(full.expenseBudgets?.map((b) => b.id)).toEqual([id(401), id(402)])
    expect(expensesHeld(full)).toEqual({ expenses: 3, cards: 2, budgets: 2 })
    // Without them: the file is exactly as before the expenses.
    expect(Object.keys(backup).sort()).toEqual(['account', 'bets', 'exportedAt', 'format', 'moves', 'settings', 'version'])
    expect(expensesHeld(backup)).toEqual({ expenses: 0, cards: 0, budgets: 0 })
    // Empty lists are still written: the file says there were none.
    const empty = makeBackup(bets, [], settings, { id: ME, email: null }, new Date(), { expenses: [], expenseCards: [], expenseBudgets: [] })
    expect(empty.expenses).toEqual([])
    expect(empty.expenseCards).toEqual([])
    expect(empty.expenseBudgets).toEqual([])
  })
})

describe('readBackup', () => {
  it('reads back exactly what was written: bets, moves, settings, version', () => {
    const read = readBackup(text)
    if (!read.ok) throw new Error(read.key)
    expect(read.bad).toEqual([])
    expect(read.backup.version).toBe(BACKUP_VERSION)
    expect(read.backup.bets).toEqual(backup.bets)
    expect(read.backup.moves).toEqual(backup.moves)
    expect(read.backup.settings).toEqual(backup.settings)
  })

  it('refuses what is not a backup, a damaged one, one from a newer version, or nonsense settings, before anything is applied', () => {
    expect(readBackup('{oops')).toMatchObject({ ok: false, key: 'backup.notJson' })
    expect(readBackup('{"format":"other"}')).toMatchObject({ ok: false, key: 'backup.notBackup' })
    expect(readBackup(JSON.stringify({ ...backup, version: 2 }))).toMatchObject({ ok: false, key: 'backup.newer', vars: { version: 2 } })
    expect(readBackup(JSON.stringify({ ...backup, bets: 'x' }))).toMatchObject({ ok: false, key: 'backup.damaged' })
    expect(readBackup(JSON.stringify({ ...backup, settings: { ...backup.settings, unitSize: -1 } }))).toMatchObject({ ok: false, key: 'backup.badSettings' })
  })

  it('reads back the expenses, cards, budgets and the expenses’ currency', () => {
    const read = readBackup(JSON.stringify(full))
    if (!read.ok) throw new Error(read.key)
    expect(read.bad).toEqual([])
    expect(read.backup.expenses).toEqual(full.expenses)
    expect(read.backup.expenseCards).toEqual(full.expenseCards)
    expect(read.backup.expenseBudgets).toEqual(full.expenseBudgets)
    expect(read.backup.settings).toEqual(full.settings)
    expect(read.backup.settings.expenseCurrency).toBe('EUR')
  })

  it('a backup from before the expenses has no lists and no currency (never null)', () => {
    const { expenseCurrency: _none, ...old } = backup.settings
    const read = readBackup(JSON.stringify({ ...backup, settings: old }))
    if (!read.ok) throw new Error(read.key)
    expect('expenseCurrency' in read.backup.settings).toBe(false)
    expect('expenses' in read.backup).toBe(false)
    expect('expenseCards' in read.backup).toBe(false)
    expect('expenseBudgets' in read.backup).toBe(false)
  })

  it('treats an expense list that is not a list as absent: the bets and moves can still be restored', () => {
    const read = readBackup(JSON.stringify({ ...full, expenses: 'x', expenseCards: { a: 1 }, expenseBudgets: null }))
    if (!read.ok) throw new Error(read.key)
    expect(read.backup.bets).toHaveLength(3)
    expect('expenses' in read.backup).toBe(false)
    expect('expenseCards' in read.backup).toBe(false)
    expect('expenseBudgets' in read.backup).toBe(false)
    expect(expensesHeld(read.backup)).toEqual({ expenses: 0, cards: 0, budgets: 0 })
  })

  it('drops, without listing them, expenses, cards and budgets that fail the app’s checks', () => {
    const [e1, e2, e3] = full.expenses as Expense[]
    const file = {
      ...full,
      expenses: [e1, { ...e2, id: 'nope' }, { ...e3, amount: 0 }, { ...e3, amount: '4.50' }, { ...e3, cardId: 'card-a' }, { ...e3, date: '2026-02-30' }, e1, { ...e3, category: 'casino', merchant: '  Bar\nUno  ' }, 7],
      expenseCards: [{ ...extras.expenseCards[0], name: '' }, { ...extras.expenseCards[0], last4: '12a4' }, { ...extras.expenseCards[0], kind: 'gold' }, extras.expenseCards[1]],
      expenseBudgets: [{ ...extras.expenseBudgets[0], monthlyLimit: 0 }, { ...extras.expenseBudgets[0], scope: 'week' }, { ...extras.expenseBudgets[0], target: 'casino' }, extras.expenseBudgets[1]]
    }
    const read = readBackup(JSON.stringify(file))
    if (!read.ok) throw new Error(read.key)
    // Only bets and moves are ever listed as entries that can't be restored.
    expect(read.bad).toEqual([])
    // The second e1 is the same id again; the unknown category is filed as other.
    expect(read.backup.expenses?.map((e) => e.id)).toEqual([e1.id, e3.id])
    expect(read.backup.expenses?.[1]).toMatchObject({ category: 'other', merchant: 'Bar Uno' })
    expect(read.backup.expenseCards?.map((c) => c.id)).toEqual([extras.expenseCards[1].id])
    expect(read.backup.expenseBudgets?.map((b) => b.id)).toEqual([extras.expenseBudgets[1].id])
  })

  it('keeps a currency code (uppercased), and refuses settings with one that isn’t', () => {
    const withCode = (code: unknown): ReturnType<typeof readBackup> => readBackup(JSON.stringify({ ...backup, settings: { ...backup.settings, expenseCurrency: code } }))
    expect(withCode('cop')).toMatchObject({ ok: true, backup: { settings: { expenseCurrency: 'COP' } } })
    for (const bad of ['dollars', 'US', 12, null, '']) expect(withCode(bad)).toMatchObject({ ok: false, key: 'backup.badSettings' })
  })

  it('leaves out, and lists, an entry that fails the app’s checks', () => {
    const bad = { ...backup, bets: [...backup.bets, { ...backup.bets[0], id: 'not-a-uuid' }, { ...backup.bets[0], id: id(9), status: 'won', amount: -5 }], moves: [...backup.moves, { ...backup.moves[0], id: id(99), amount: 0 }] }
    const read = readBackup(JSON.stringify(bad))
    if (!read.ok) throw new Error(read.key)
    expect(read.backup.bets).toHaveLength(3)
    expect(read.bad).toEqual([
      expect.objectContaining({ kind: 'bet', index: 4, key: 'backup.badEntry' }),
      expect.objectContaining({ kind: 'bet', index: 5, key: 'invalid.wonPositive' }),
      expect.objectContaining({ kind: 'move', index: 2, key: 'invalid.moveZero' })
    ])
  })
})

describe('planRestore', () => {
  let n = 1000
  const newId = (): string => id(n++)

  it('of this account: adds only what is missing, keeps its ids, never changes what is here', () => {
    const edited = { ...bets[0], note: 'edited since' }
    const plan = planRestore(backup, { userId: ME, bets: [edited, bets[2]], moves: [], settings }, newId)
    expect(plan.otherAccount).toBe(false)
    expect(plan.newBets.map((b) => b.id)).toEqual([id(2)])
    expect(plan.sameBets).toBe(1)
    expect(plan.changedBets).toBe(1)
    expect(plan.newMoves.map((m) => m.id)).toEqual([id(101)])
    expect(plan.settingsDiffer).toBe(false)
  })

  it('restoring the same backup twice adds nothing the second time', () => {
    const plan = planRestore(backup, { userId: ME, bets, moves: [move(1, 500)], settings }, newId)
    expect(plan.newBets).toEqual([])
    expect(plan.newMoves).toEqual([])
    expect(plan.sameBets).toBe(3)
  })

  it('never restores the expenses, cards or budgets: the plan has no place for them', () => {
    const plan = planRestore(full, { userId: ME, bets, moves: [move(1, 500)], settings: { ...settings, expenseCurrency: 'EUR' } }, newId)
    expect(plan.newBets).toEqual([])
    expect(plan.newMoves).toEqual([])
    expect(plan.settingsDiffer).toBe(false)
    expect(Object.keys(plan).filter((k) => /expense|card|budget/i.test(k))).toEqual([])
  })

  it('offers the expenses’ currency like any other setting, only when the backup has one', () => {
    const here = { userId: ME, bets, moves: [move(1, 500)], settings }
    const eur: Backup = { ...backup, settings: { ...backup.settings, expenseCurrency: 'EUR' } }
    const plan = planRestore(eur, here, newId)
    expect(plan.settingsDiffer).toBe(true)
    expect(settingsChange(settings, plan.settings)).toEqual({ before: { expenseCurrency: 'USD' }, after: { expenseCurrency: 'EUR' } })
    // A backup from before the expenses never changes it.
    const { expenseCurrency: _none, ...old } = backup.settings
    const before = planRestore({ ...backup, settings: old }, { ...here, settings: { ...settings, expenseCurrency: 'EUR' } }, newId)
    expect(before.settingsDiffer).toBe(false)
    expect(settingsChange({ ...settings, expenseCurrency: 'EUR' }, before.settings)).toBeNull()
  })

  it('leaves the currency out when this device has no proof the expenses’ tables exist', () => {
    const eur: Backup = { ...backup, settings: { ...backup.settings, expenseCurrency: 'EUR' } }
    const here = { userId: ME, bets, moves: [move(1, 500)], settings }
    const plan = planRestore(eur, { ...here, currencyWritable: false }, newId)
    expect(plan.settingsDiffer).toBe(false)
    expect('expenseCurrency' in plan.settings).toBe(false)
    expect(settingsChange(settings, plan.settings)).toBeNull()
    // The other settings are still offered, without it.
    const other = planRestore({ ...eur, settings: { ...eur.settings, oddsFormat: 'american' } }, { ...here, currencyWritable: false }, newId)
    expect(other.settingsDiffer).toBe(true)
    expect(settingsChange(settings, other.settings)).toEqual({ before: { oddsFormat: 'decimal' }, after: { oddsFormat: 'american' } })
    // And the signature is the one of a backup with no currency.
    const { expenseCurrency: _none, ...old } = eur.settings
    expect(plan.signature).toBe(planRestore({ ...eur, settings: old }, here, newId).signature)
    expect(plan.signature).not.toBe(planRestore(eur, here, newId).signature)
  })

  it('the signature changes with the currency here', () => {
    const here = { userId: ME, bets, moves: [], settings }
    const a = planRestore(backup, here, newId)
    const b = planRestore(backup, { ...here, settings: { ...settings, expenseCurrency: 'MXN' } }, newId)
    expect(a.signature).not.toBe(b.signature)
  })

  it('of another account: new ids, and bets that look like bets here are possible duplicates', () => {
    const plan = planRestore(backup, { userId: 'someone-else', bets: [bets[1]], moves: [], settings: DEFAULT_SETTINGS }, newId)
    expect(plan.otherAccount).toBe(true)
    expect(plan.duplicateBets).toHaveLength(1)
    expect(plan.newBets).toHaveLength(2)
    expect([...plan.newBets, ...plan.duplicateBets].every((b) => !bets.some((x) => x.id === b.id))).toBe(true)
    expect(plan.newMoves[0].id).not.toBe(id(101))
    expect(plan.settingsDiffer).toBe(true)
  })
})
