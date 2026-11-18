import {
  isCurrencyCode,
  isOddsFormat,
  type BankrollMove,
  type Bet,
  type BudgetScope,
  type CardKind,
  type Expense,
  type ExpenseBudget,
  type ExpenseCard,
  type Settings,
  type SettingsPatch
} from '../../../shared/types'
import { duplicateKey } from './importPlan'
import type { StringKey } from './strings'
import { InputError, MAX_AMOUNT, normalizeBudget, normalizeCard, normalizeExpense, normalizeInput, normalizeMove, round2 } from './validate'

/**
 * A full backup: every bet, every deposit and withdrawal, and the settings,
 * in one JSON file, and the expenses with their cards and monthly budgets.
 * Unlike the bets CSV (for spreadsheets and other trackers), it keeps ids,
 * so restoring it twice adds nothing the second time, and nothing is lost in
 * a round trip.
 *
 *   {
 *     "format": "bettracker-backup",
 *     "version": 1,
 *     "exportedAt": "2026-10-20T09:00:00.000Z",
 *     "account": { "id": "…", "email": "…" },
 *     "bets": [ { "id", "date", "amount", "stake", "odds", "closingOdds",
 *                 "status", "note", "sport", "book", "betType",
 *                 "createdAt", "updatedAt" } ],
 *     "moves": [ { "id", "date", "amount", "note", "createdAt", "updatedAt" } ],
 *     "settings": { "oddsFormat", "unitSize", "showUnits", "startingBankroll",
 *                   "defaultStake", "lossLimit", "expenseCurrency" },
 *     "expenses": [ { "id", "date", "amount", "originalAmount",
 *                     "originalCurrency", "fxRate", "cardId", "merchant",
 *                     "category", "note", "source", "createdAt", "updatedAt" } ],
 *     "expenseCards": [ { "id", "name", "last4", "kind", "archived",
 *                         "createdAt", "updatedAt" } ],
 *     "expenseBudgets": [ { "id", "scope", "target", "monthlyLimit",
 *                           "createdAt", "updatedAt" } ]
 *   }
 *
 * The three expense lists and `settings.expenseCurrency` came later (the
 * expenses, migration 008) and are optional: a file from before has none,
 * and an app from before ignores them, so `version` stays 1. This version
 * reads and counts them but can't restore them yet (only the currency, which
 * is a setting like the others): the restore says so, and never counts them
 * as restored. A malformed expense list is treated as absent, never as a
 * damaged file, so it can't keep the bets and moves from being restored.
 *
 * An expense's `originalAmount`, `originalCurrency` and `fxRate` came later
 * still (an expense paid in another currency, migration 009) and are optional
 * too: all three (what was paid, its ISO code, and the rate to the expense
 * currency) or none. A file from before has none of them, and each expense
 * in it reads as one in the user's own currency (the three null).
 *
 * A later version that adds fields keeps `version` 1 as long as an older app
 * can ignore them; one an older app would misread raises it, and an older
 * app refuses that file rather than half-restoring it.
 */
export const BACKUP_FORMAT = 'bettracker-backup'
export const BACKUP_VERSION = 1

/** `expenseCurrency` is optional: a backup from before expenses has none (missing = undefined, never null). */
export type BackupSettings = Omit<Settings, 'updatedAt' | 'expenseCurrency'> & { expenseCurrency?: string }

export interface Backup {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_VERSION
  exportedAt: string
  account: { id: string; email: string | null }
  bets: Bet[]
  moves: BankrollMove[]
  settings: BackupSettings
  /** Kept in the file, read and counted, not restored by this version. */
  expenses?: Expense[]
  expenseCards?: ExpenseCard[]
  expenseBudgets?: ExpenseBudget[]
}

/** The expenses, cards and budgets a backup also holds (see makeBackup). */
export interface BackupExtras {
  expenses: readonly Expense[]
  expenseCards: readonly ExpenseCard[]
  expenseBudgets: readonly ExpenseBudget[]
}

/** Oldest first by `createdAt`, then by id: the same file from the same data. */
const byCreated = <T extends { id: string; createdAt: string }>(a: T, b: T): number =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0

export function makeBackup(
  bets: readonly Bet[],
  moves: readonly BankrollMove[],
  settings: Settings,
  account: { id: string; email: string | null },
  now = new Date(),
  extra?: BackupExtras
): Backup {
  const { updatedAt: _ignored, ...rest } = settings
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    account,
    bets: [...bets].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt < b.createdAt ? -1 : 1)),
    moves: [...moves].sort((a, b) => (a.date < b.date ? -1 : 1)),
    settings: rest,
    ...(extra
      ? {
          expenses: [...extra.expenses].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : byCreated(a, b))),
          expenseCards: [...extra.expenseCards].sort(byCreated),
          expenseBudgets: [...extra.expenseBudgets].sort(byCreated)
        }
      : {})
  }
}

/** How many expenses, cards and budgets a backup holds (none, for one from before them). */
export function expensesHeld(backup: Backup): { expenses: number; cards: number; budgets: number } {
  return { expenses: backup.expenses?.length ?? 0, cards: backup.expenseCards?.length ?? 0, budgets: backup.expenseBudgets?.length ?? 0 }
}

/** Download a backup as a .json file. Works in the PWA and Electron alike. */
export function downloadBackup(backup: Backup): void {
  const d = new Date(backup.exportedAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const name = `bettracker-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** An entry of the file that can't be restored, and why. */
export interface BadEntry {
  kind: 'bet' | 'move'
  /** Its place in the file's list, from 1. */
  index: number
  key: StringKey
  vars: Record<string, string | number>
}

export type ReadBackup = { ok: true; backup: Backup; bad: BadEntry[] } | { ok: false; key: StringKey; vars?: Record<string, string | number> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const numOrNull = (v: unknown): number | null | 'bad' => (v === null || v === undefined ? null : typeof v === 'number' && Number.isFinite(v) ? v : 'bad')

/** Why an entry can't be restored, in the user's words. */
const reason = (err: unknown): Pick<BadEntry, 'key' | 'vars'> =>
  err instanceof InputError ? { key: `invalid.${err.code}` as StringKey, vars: err.vars } : { key: 'backup.badEntry', vars: {} }

/** A money setting: null, or a number in range (above 0 where the database wants it). */
function money(v: unknown, positive: boolean): number | null | 'bad' {
  const n = numOrNull(v)
  if (n === null || n === 'bad') return n
  const r = round2(n)
  if (r < 0 || r > MAX_AMOUNT || (positive && r === 0)) return 'bad'
  return r
}

/**
 * Read and check a backup file before anything is applied. The file as a
 * whole must be one (format, version, lists); a bet or a move in it that
 * fails the app's own checks is left out and listed, never half-restored.
 * Settings that make no sense are refused as a whole.
 */
export function readBackup(text: string): ReadBackup {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, key: 'backup.notJson' }
  }
  if (!isObject(raw) || raw.format !== BACKUP_FORMAT) return { ok: false, key: 'backup.notBackup' }
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) return { ok: false, key: 'backup.notBackup' }
  if (raw.version > BACKUP_VERSION) return { ok: false, key: 'backup.newer', vars: { version: raw.version } }
  if (!Array.isArray(raw.bets) || !Array.isArray(raw.moves) || !isObject(raw.settings)) return { ok: false, key: 'backup.damaged' }

  const bad: BadEntry[] = []
  const bets: Bet[] = []
  const seenBets = new Set<string>()
  raw.bets.forEach((b, i) => {
    const index = i + 1
    if (!isObject(b) || typeof b.id !== 'string' || !UUID.test(b.id) || seenBets.has(b.id)) {
      bad.push({ kind: 'bet', index, key: 'backup.badEntry', vars: {} })
      return
    }
    const nums = [numOrNull(b.amount), numOrNull(b.stake), numOrNull(b.odds), numOrNull(b.closingOdds)]
    if (nums.includes('bad')) {
      bad.push({ kind: 'bet', index, key: 'backup.badEntry', vars: {} })
      return
    }
    const [amount, stake, odds, closingOdds] = nums as (number | null)[]
    try {
      const clean = normalizeInput({
        date: str(b.date),
        amount,
        stake,
        odds,
        closingOdds,
        status: typeof b.status === 'string' ? (b.status as Bet['status']) : undefined,
        note: str(b.note),
        sport: str(b.sport),
        book: str(b.book),
        betType: str(b.betType)
      })
      seenBets.add(b.id)
      const createdAt = str(b.createdAt, new Date(0).toISOString())
      bets.push({ id: b.id, ...clean, createdAt, updatedAt: str(b.updatedAt, createdAt) })
    } catch (err) {
      bad.push({ kind: 'bet', index, ...reason(err) })
    }
  })

  const moves: BankrollMove[] = []
  const seenMoves = new Set<string>()
  raw.moves.forEach((m, i) => {
    const index = i + 1
    if (!isObject(m) || typeof m.id !== 'string' || !UUID.test(m.id) || seenMoves.has(m.id) || typeof m.amount !== 'number') {
      bad.push({ kind: 'move', index, key: 'backup.badEntry', vars: {} })
      return
    }
    try {
      const clean = normalizeMove({ date: str(m.date), amount: m.amount, note: str(m.note) })
      seenMoves.add(m.id)
      const createdAt = str(m.createdAt, new Date(0).toISOString())
      moves.push({ id: m.id, ...clean, createdAt, updatedAt: str(m.updatedAt, createdAt) })
    } catch (err) {
      bad.push({ kind: 'move', index, ...reason(err) })
    }
  })

  // The expenses, cards and budgets: optional, and only read and counted
  // (this version can't restore them). A list that is missing or not a list
  // is left out; an entry that fails the app's checks is dropped without a
  // word, since nothing of them is restored anyway.
  const expenses = optionalList(raw.expenses, (e, id, createdAt, updatedAt): Expense => {
    const amount = typeof e.amount === 'number' ? e.amount : NaN
    const clean = normalizeExpense({
      date: str(e.date),
      amount,
      // Optional (a file from before 009 has none). A file that holds only some of the three, or nonsense in one, fails
      // the app's checks like any other bad entry.
      originalAmount: e.originalAmount === undefined || e.originalAmount === null ? null : typeof e.originalAmount === 'number' ? e.originalAmount : NaN,
      originalCurrency: e.originalCurrency === undefined || e.originalCurrency === null ? null : str(e.originalCurrency, '?'),
      fxRate: e.fxRate === undefined || e.fxRate === null ? null : typeof e.fxRate === 'number' ? e.fxRate : NaN,
      cardId: typeof e.cardId === 'string' ? e.cardId : null,
      merchant: str(e.merchant),
      category: str(e.category),
      note: str(e.note),
      source: e.source === 'ai' ? 'ai' : 'manual'
    })
    return { id, ...clean, createdAt, updatedAt }
  })
  const expenseCards = optionalList(raw.expenseCards, (c, id, createdAt, updatedAt): ExpenseCard => {
    const clean = normalizeCard({ name: str(c.name), last4: str(c.last4), kind: c.kind as CardKind, archived: c.archived === true })
    return { id, ...clean, createdAt, updatedAt }
  })
  const expenseBudgets = optionalList(raw.expenseBudgets, (b, id, createdAt, updatedAt): ExpenseBudget => {
    const clean = normalizeBudget({ scope: b.scope as BudgetScope, target: str(b.target), monthlyLimit: typeof b.monthlyLimit === 'number' ? b.monthlyLimit : NaN })
    return { id, ...clean, createdAt, updatedAt }
  })

  const s = raw.settings
  const unitSize = money(s.unitSize, true)
  const startingBankroll = money(s.startingBankroll, false)
  const defaultStake = money(s.defaultStake, false)
  const lossLimit = money(s.lossLimit, true)
  // Missing (a backup from before expenses): left out, so a restore never
  // changes the currency. Present, it must be a currency code like any other
  // setting must make sense.
  const expenseCurrency = s.expenseCurrency === undefined ? undefined : typeof s.expenseCurrency === 'string' ? s.expenseCurrency.trim().toUpperCase() : null
  if (
    !isOddsFormat(s.oddsFormat) ||
    typeof s.showUnits !== 'boolean' ||
    [unitSize, startingBankroll, defaultStake, lossLimit].includes('bad') ||
    (expenseCurrency !== undefined && !isCurrencyCode(expenseCurrency))
  ) {
    return { ok: false, key: 'backup.badSettings' }
  }
  const account = isObject(raw.account) ? { id: str(raw.account.id), email: typeof raw.account.email === 'string' ? raw.account.email : null } : { id: '', email: null }

  return {
    ok: true,
    bad,
    backup: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: str(raw.exportedAt),
      account,
      bets,
      moves,
      settings: {
        oddsFormat: s.oddsFormat,
        showUnits: s.showUnits,
        unitSize: unitSize as number | null,
        startingBankroll: startingBankroll as number | null,
        defaultStake: defaultStake as number | null,
        lossLimit: lossLimit as number | null,
        ...(expenseCurrency !== undefined ? { expenseCurrency: expenseCurrency as string } : {})
      },
      ...(expenses ? { expenses } : {}),
      ...(expenseCards ? { expenseCards } : {}),
      ...(expenseBudgets ? { expenseBudgets } : {})
    }
  }
}

/**
 * One of the backup's optional lists (expenses, cards, budgets): undefined
 * when the file has none or it is not a list. Each entry needs a UUID id not
 * seen before and must pass `make` (the app's own checks, which throw);
 * anything else is dropped.
 */
function optionalList<T>(list: unknown, make: (entry: Record<string, unknown>, id: string, createdAt: string, updatedAt: string) => T): T[] | undefined {
  if (!Array.isArray(list)) return undefined
  const out: T[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (!isObject(entry) || typeof entry.id !== 'string' || !UUID.test(entry.id) || seen.has(entry.id)) continue
    const createdAt = str(entry.createdAt, new Date(0).toISOString())
    try {
      out.push(make(entry, entry.id, createdAt, str(entry.updatedAt, createdAt)))
      seen.add(entry.id)
    } catch {
      // Not a valid entry: dropped (see above).
    }
  }
  return out
}

/**
 * What restoring a backup would do. Nothing already here is ever changed or
 * deleted: a restore only adds.
 *  - A backup of this account keeps its ids. A bet or move whose id is here
 *    already is left as it is now (same, or since edited: `changed`), so
 *    restoring the same file twice adds nothing; one deleted since comes
 *    back.
 *  - A backup of another account gets new ids (its own could belong to rows
 *    this account can't see), and its bets are matched by content instead,
 *    like a CSV import: a bet that looks like one here is a possible
 *    duplicate, skipped unless the user keeps it.
 *  - The settings replace these only when the user asks (`settingsDiffer`
 *    says whether there is anything to replace).
 *  - The expenses, cards and budgets in the file are never restored by this
 *    version (the review says how many there are; see expensesHeld).
 */
export interface RestorePlan {
  otherAccount: boolean
  newBets: Bet[]
  /** Another account's bets that look like bets here. */
  duplicateBets: Bet[]
  /**
   * For each of `duplicateBets`, the bet here it looks like (to compare
   * them) and its id in the backup (stable when the plan is made again: the
   * copy's own id is new each time).
   */
  duplicateOf: Bet[]
  duplicateSources: string[]
  sameBets: number
  /** Here with the same id but different now: kept as they are now. */
  changedBets: number
  newMoves: BankrollMove[]
  sameMoves: number
  changedMoves: number
  settingsDiffer: boolean
  settings: SettingsPatch
  /**
   * What the plan would do, the same whenever it is made from the same data:
   * made again just before it is applied, a different one means the data
   * changed since the review (another device, another window), and the user
   * reviews the new plan first.
   */
  signature: string
}

const sameBet = (a: Bet, b: Bet): boolean => duplicateKey(a) === duplicateKey(b) && a.note === b.note && a.closingOdds === b.closingOdds
const sameMove = (a: BankrollMove, b: BankrollMove): boolean => a.date === b.date && a.amount === b.amount && a.note === b.note

export function planRestore(
  backup: Backup,
  here: {
    userId: string
    bets: readonly Bet[]
    moves: readonly BankrollMove[]
    settings: Settings
    /**
     * Whether this device has seen the expenses' tables (migration 008) work
     * (default true). Without that proof the backup's expenses currency is
     * left out, as if the file had none: a patch naming it could be refused
     * by a database from before 008, and hold the other settings with it.
     */
    currencyWritable?: boolean
  },
  newId: () => string
): RestorePlan {
  if (here.currencyWritable === false && backup.settings.expenseCurrency !== undefined) {
    const { expenseCurrency: _unwritable, ...settings } = backup.settings
    backup = { ...backup, settings }
  }
  const otherAccount = backup.account.id !== here.userId
  const betsById = new Map(here.bets.map((b) => [b.id, b]))
  const movesById = new Map(here.moves.map((m) => [m.id, m]))
  const plan: RestorePlan = {
    otherAccount,
    newBets: [],
    duplicateBets: [],
    duplicateOf: [],
    duplicateSources: [],
    sameBets: 0,
    changedBets: 0,
    newMoves: [],
    sameMoves: 0,
    changedMoves: 0,
    settingsDiffer: false,
    settings: backup.settings,
    signature: ''
  }
  // Where each planned row comes from in the backup, for the signature.
  const sources = { newBets: [] as string[], newMoves: [] as string[] }

  if (otherAccount) {
    const matches = new Map<string, Bet[]>()
    for (const b of here.bets) {
      const same = matches.get(duplicateKey(b))
      if (same) same.push(b)
      else matches.set(duplicateKey(b), [b])
    }
    for (const b of backup.bets) {
      const left = matches.get(duplicateKey(b)) ?? []
      const copy = { ...b, id: newId() }
      const match = left.shift()
      if (match) {
        plan.duplicateBets.push(copy)
        plan.duplicateOf.push(match)
        plan.duplicateSources.push(b.id)
      } else {
        plan.newBets.push(copy)
        sources.newBets.push(b.id)
      }
    }
    const moveKeys = new Map<string, number>()
    const mk = (m: BankrollMove): string => `${m.date}|${m.amount}|${m.note}`
    for (const m of here.moves) moveKeys.set(mk(m), (moveKeys.get(mk(m)) ?? 0) + 1)
    for (const m of backup.moves) {
      const left = moveKeys.get(mk(m)) ?? 0
      if (left > 0) {
        moveKeys.set(mk(m), left - 1)
        plan.sameMoves++
      } else {
        plan.newMoves.push({ ...m, id: newId() })
        sources.newMoves.push(m.id)
      }
    }
  } else {
    for (const b of backup.bets) {
      const now = betsById.get(b.id)
      if (!now) {
        plan.newBets.push(b)
        sources.newBets.push(b.id)
      } else if (sameBet(now, b)) plan.sameBets++
      else plan.changedBets++
    }
    for (const m of backup.moves) {
      const now = movesById.get(m.id)
      if (!now) {
        plan.newMoves.push(m)
        sources.newMoves.push(m.id)
      } else if (sameMove(now, m)) plan.sameMoves++
      else plan.changedMoves++
    }
  }

  const s = here.settings
  const b = backup.settings
  plan.settingsDiffer =
    s.oddsFormat !== b.oddsFormat ||
    s.unitSize !== b.unitSize ||
    s.showUnits !== b.showUnits ||
    s.startingBankroll !== b.startingBankroll ||
    s.defaultStake !== b.defaultStake ||
    s.lossLimit !== b.lossLimit ||
    (b.expenseCurrency !== undefined && s.expenseCurrency !== b.expenseCurrency)
  plan.signature = JSON.stringify([
    otherAccount,
    sources.newBets,
    plan.duplicateSources,
    plan.duplicateOf.map((m) => m.id),
    plan.sameBets,
    plan.changedBets,
    sources.newMoves,
    plan.sameMoves,
    plan.changedMoves,
    plan.settingsDiffer,
    SETTING_FIELDS.map((k) => s[k])
  ])
  return plan
}

/** The settings a backup holds, in a fixed order (`expenseCurrency` only in one made since the expenses). */
export const SETTING_FIELDS = ['oddsFormat', 'unitSize', 'showUnits', 'startingBankroll', 'defaultStake', 'lossLimit', 'expenseCurrency'] as const

/**
 * The settings a restore replaces: each field where the backup differs from
 * what is here now, as it is now and as the backup has it (the Undo puts
 * back `before`, see App's undoBatch).
 */
export function settingsChange(here: Settings, backup: SettingsPatch): { before: SettingsPatch; after: SettingsPatch } | null {
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  for (const k of SETTING_FIELDS) {
    if (backup[k] === undefined || Object.is(here[k], backup[k])) continue
    before[k] = here[k]
    after[k] = backup[k]
  }
  return Object.keys(after).length > 0 ? { before: before as SettingsPatch, after: after as SettingsPatch } : null
}
