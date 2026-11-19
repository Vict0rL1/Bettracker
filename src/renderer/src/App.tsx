import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_SETTINGS,
  type BankrollMove,
  type Bet,
  type BetInput,
  type BetStatus,
  type BudgetScope,
  type Expense,
  type ExpenseCard,
  type ExpenseCardInput,
  type ExpenseInput,
  type MoveInput
} from '../../shared/types'
import BalanceChart from './components/BalanceChart'
import BankrollDialog from './components/BankrollDialog'
import Breakdown from './components/Breakdown'
import CalendarView from './components/CalendarView'
import DataDialog, { type ImportChoice, type ImportOutcome, type RestoreChoice, type RestoreOutcome } from './components/DataDialog'
import FirstRun from './components/FirstRun'
import DayModal, { type DayDrafts, type TagSuggestions } from './components/DayModal'
import Header from './components/Header'
import ViewTabs from './components/ViewTabs'
import type { ExpenseSettingsSection } from './components/expenses/ExpensesView'
import HeroStats, { AdvancedSection, AdvancedStats, KeyStats } from './components/HeroStats'
import HistoryTable from './components/HistoryTable'
import LossBanner from './components/LossBanner'
import PendingPanel from './components/PendingPanel'
import QuickAdd from './components/QuickAdd'
import RangeBar from './components/RangeBar'
import SettingsDialog from './components/SettingsDialog'
import SyncNotices from './components/SyncNotices'
import Toast, { type ToastMsg } from './components/Toast'
import Login from './auth/Login'
import NewPassword from './auth/NewPassword'
import { useAuth } from './auth/AuthProvider'
import { authErrorKey } from './auth/authErrors'
import { combinedStatus, sharedMigrationNotice } from './data/drain'
import { classifySyncError } from './data/errors'
import { StorageWriteError } from './data/store'
import { hasStoredSession } from './lib/supabase'
import { useBetSync } from './data/useBetSync'
import { useMoves } from './data/useMoves'
import { migration008, migration009, useRowSync } from './data/useRowSync'
import { budgetsTable, cardsTable, expensesTable } from './data/expenses'
import { CARDS_SPEC } from './data/expenseSpecs'
import { loadExpenseLast, rememberPayCurrency, saveExpenseLast } from './data/expenseLast'
import type { ExtractOutcome } from './data/extract'
import { dayDraftId, loadDayDraft, loadQuickDraft, saveDayDraft, saveQuickDraft, type QuickDraft } from './data/drafts'
import {
  batchOf,
  changeImport,
  freshImports,
  HistoryFullError,
  loadImports,
  recordBatchEvent,
  settingsAnswer,
  unanswered,
  withOperation,
  type BatchEvent,
  type ImportBatch,
  type SettingsField
} from './data/imports'
import {
  checkSettings,
  continueOperation,
  preparedParts,
  queueParts,
  redoBatch,
  resumeOperations,
  retrySettingsOf,
  startOperation,
  undoSettingsLog,
  type OperationPorts
} from './data/operations'
import { readdStamp, sameStamp } from './data/offline'
import { rowStamps } from './data/bets'
import { getSettings } from './data/settings'
import { normalizeInput, normalizeMove } from './lib/validate'
import { batchStatus, type BatchLive, type RecoveryAction } from './lib/batchStatus'
import { planImport } from './lib/importPlan'
import { newId } from './lib/uuid'
import { downloadBackup, makeBackup, planRestore, settingsChange } from './lib/backup'
import { useSettings, type SettingsOutcomeEvent } from './data/useSettings'
import { bankrollNow } from './lib/bankroll'
import { retagPlan, settlePlan, toInput, type TagPatch } from './lib/bulk'
import { downloadCsv } from './lib/csv'
import { moneyFormat } from './lib/format'
import { getLang, useLang } from './lib/i18n'
import { dismissKey, loadLossDismissed, lossState, saveLossDismissed } from './lib/lossLimit'
import { MoneyContext } from './lib/money'
import { openBets } from './lib/pending'
import { filterRange, loadRange, rangeBounds, saveRange, type DateRange } from './lib/range'
import { forMonth, groupByDay, summarize, tagValues, total, type DaySummary } from './lib/stats'
import { useTheme } from './lib/theme'
import { addMonths, currentMonth, humanDate, todayStr, type MonthKey } from './lib/dates'
import { effectiveUnit } from './lib/validate'
import { PlusIcon } from './components/icons'
import { toCategory } from './lib/categories'
import { currencyFormat } from './lib/currency'
import { downloadExpensesCsv } from './lib/expenseCsv'
import { cardDeleteMode, type ExpenseDraft } from './lib/expenseForm'
import type { PreparedImage } from './lib/scanImageDom'
import { monthSpend } from './lib/spend'
import { budgetId } from './lib/stableId'
import { loadView, saveView, type AppView } from './lib/view'

// The expenses' screens, Recharts with them, load only when the Expenses view
// (or one of its sheets) opens: the bets' first paint never waits for them.
const ExpensesView = lazy(() => import('./components/expenses/ExpensesView'))
const ExpenseSheet = lazy(() => import('./components/expenses/ExpenseSheet'))
const ExpenseSettings = lazy(() => import('./components/expenses/ExpenseSettings'))

/** The expense sheet: adding (by hand or with its Scan receipt; a draft handed back from Expense settings), or editing one. */
type ExpenseSheetState = { kind: 'add'; draft?: ExpenseDraft; preferCardId?: string } | { kind: 'edit'; id: string }

const kindOf = (amount: number): 'deposit' | 'withdrawal' => (amount > 0 ? 'deposit' : 'withdrawal')

/** How often a window looks for operations another window left prepared (see data/operations.ts). */
const RESUME_INTERVAL_MS = 20_000
const NONE_QUEUED = { adds: 0, removals: 0 }

/** Rows (and a settings write) an operation has written down but not queued yet: lost if the user signs out now. */
function unqueuedOf(b: ImportBatch): number {
  let n = 0
  if (b.parts?.bets?.phase === 'prepared') n += unanswered(b, 'bets').length
  if (b.parts?.moves?.phase === 'prepared') n += unanswered(b, 'moves').length
  if (b.restore?.settings?.phase === 'prepared') n += 1
  if (b.undo?.phase === 'prepared') n += b.undo.bets.length + b.undo.moves.length - b.undo.removed.length - b.undo.kept.length
  if (b.undo?.settings?.phase === 'prepared') n += 1
  return Math.max(0, n)
}

function Boot() {
  return (
    <div className="boot">
      <span>
        Bet<span className="boot-accent">Tracker</span>
      </span>
    </div>
  )
}

export default function App() {
  const { loading, session, userId, email, offlineUser, signOut, recovering } = useAuth()
  const { theme, toggle: toggleTheme } = useTheme()
  const { t, tn } = useLang()

  // With a live session we sync; with only a cached identity (e.g. reopened
  // fully offline) the app still renders this device's copy of the data.
  const activeUserId = userId ?? offlineUser?.id ?? null
  const activeEmail = email ?? offlineUser?.email ?? null

  const [ym, setYm] = useState<MonthKey>(currentMonth)
  // The day open, and the bet in it being edited (as `as`, when settling one).
  const [day, setDay] = useState<{ date: string; edit?: { id: string; as?: BetStatus } } | null>(null)
  const openDay = useCallback((date: string) => setDay({ date }), [])
  const [quickOpen, setQuickOpen] = useState(false)
  // The quick add's draft as it opened (see data/drafts.ts).
  const [quickStart, setQuickStart] = useState<QuickDraft | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pendingOpen, setPendingOpen] = useState(false)
  const [bankrollOpen, setBankrollOpen] = useState(false)
  const [dataOpen, setDataOpen] = useState(false)
  // Bets or Expenses: remembered on this device (see lib/view.ts).
  const [view, setViewState] = useState<AppView>(loadView)
  // Set on the first switch: the bets sections' first-paint stagger runs once per page load, not on every return.
  const [revisit, setRevisit] = useState(false)
  const changeView = useCallback((v: AppView) => {
    setViewState(v)
    saveView(v)
    setRevisit(true)
  }, [])
  const [expenseSheet, setExpenseSheet] = useState<ExpenseSheetState | null>(null)
  const [expenseSettings, setExpenseSettings] = useState<ExpenseSettingsSection | null>(null)
  // The draft of an add sheet handed over to "Add card" (memory only, never storage), and the card added meanwhile.
  const resumeRef = useRef<{ draft: ExpenseDraft; addedCardId: string | null } | null>(null)
  // The newest updatedAt seen per budget id, so a budget set again after it was cleared is stamped past its tombstone.
  const budgetSeen = useRef(new Map<string, string>())
  // The imports made on this device (see data/imports.ts), as last read.
  const [batches, setBatches] = useState<ImportBatch[]>([])
  // Each message is its own element (keyed by its seq): its entrance plays
  // again, and its end-of-life fade (index.css) is timed from its own start.
  const [toast, setToastShown] = useState<{ msg: ToastMsg; seq: number } | null>(null)
  const toastSeq = useRef(0)
  const setToast = useCallback((msg: ToastMsg | null): void => {
    toastSeq.current += 1
    setToastShown(msg && { msg, seq: toastSeq.current })
  }, [])
  // Stable, so a render of App doesn't restart the toast's timer (Toast.tsx):
  // it unmounts on time, just after its fade (index.css) ends.
  const clearToast = useCallback((): void => setToast(null), [setToast])

  // An error in the user's words where the app knows it: storage that
  // refused a change, a key Supabase refuses, a server failure that passes.
  const showError = useCallback(
    (err: unknown) => {
      const message = err instanceof Error ? err.message : ''
      let text = message || t('common.error')
      if (err instanceof StorageWriteError) text = t('toast.notSaved')
      else if (message) {
        const failure = classifySyncError(err)
        const key = failure === 'paused' ? authErrorKey({ message }) : null
        if (key) text = t(key)
        else if (failure === 'retry') text = t('toast.serverRetry', { reason: message })
      }
      setToast({ kind: 'error', text })
    },
    [t]
  )
  const showNotice = useCallback((code: 'conflict') => setToast({ kind: 'ok', text: t(`toast.${code}`) }), [t])

  // What the server made of an import's or a restore's changes, into its
  // history entry (see data/imports.ts), told by the hook that sent them.
  const activeUserRef = useRef(activeUserId)
  activeUserRef.current = activeUserId
  const onBatch = useCallback(async (e: BatchEvent) => {
    const uid = activeUserRef.current
    if (uid) setBatches(await recordBatchEvent(uid, e))
  }, [])
  // What the server made of a restore's settings, or its Undo's, by the write's generation.
  const onSettingsOutcome = useCallback(async (e: SettingsOutcomeEvent) => {
    const uid = activeUserRef.current
    if (!uid) return
    let event = settingsAnswer(e)
    // "Kept" only where the server's row shows a change made since: one that
    // still holds what was there before the write did not land (a newer edit
    // of another field moved the row on), and can be tried again.
    if (event.kind === 'settings' && e.kept.length > 0 && e.row !== undefined) {
      const s = (await freshImports(uid)).find((b) => b.id === event.batch)?.restore?.settings
      if (s) {
        const row = e.row as unknown as Partial<Record<SettingsField, unknown>> | null
        const found = checkSettings(s, row, e.kept, event.undo === true, DEFAULT_SETTINGS as unknown as Partial<Record<SettingsField, unknown>>)
        event = { ...event, confirmed: [...(event.confirmed ?? []), ...found.confirmed], kept: found.kept, missing: found.missing }
      }
    }
    setBatches(await recordBatchEvent(uid, event))
  }, [])

  const sync = useBetSync(activeUserId, Boolean(session), showError, showNotice, onBatch)
  const { bets, status, queuedCount, isOffline } = sync
  const {
    settings,
    dirty: settingsDirty,
    blocked: settingsBlocked,
    loaded: settingsLoaded,
    unsaved: settingsUnsaved,
    status: settingsStatus,
    saveState: settingsSaveState,
    pendingOrigins: settingsOrigins,
    held: settingsHeld,
    queueFresh: settingsQueueFresh,
    update: updateSettings,
    saveAgain: saveSettingsAgain
  } = useSettings(activeUserId, Boolean(session), showError, showNotice, onSettingsOutcome)
  const moves = useMoves(activeUserId, Boolean(session), showError, showNotice, onBatch)
  // Everyday expenses, their cards and monthly budgets (migration 008), each
  // synced like the moves. One "database is behind" notice for the three
  // tables, which arrive together with 008.
  const rowNotice = useMemo(() => sharedMigrationNotice(), [activeUserId])
  const rowOpts = { userId: activeUserId, canSync: Boolean(session), onError: showError, onNotice: showNotice, notice: rowNotice }
  const expenses = useRowSync({ table: expensesTable, ...rowOpts })
  const cards = useRowSync({ table: cardsTable, ...rowOpts })
  const budgets = useRowSync({ table: budgetsTable, ...rowOpts })
  const rowQueues = [expenses, cards, budgets]
  // 008 is known only from positive evidence: a read or a write of its tables went through (see useRowSync).
  const { has008, needs008 } = migration008(rowQueues)
  // 009 (an expense paid in another currency) is known missing only from an expense write refused for its columns.
  const needs009 = migration009(expenses, needs008)
  // One badge for every queue. A settings change, a deposit or an expense is
  // a queued change too: the badge says what holds it back (or that it is on
  // its way) even when no bet is queued. An empty queue has no say.
  const badgeStatus = combinedStatus([
    status,
    moves.queuedCount > 0 ? moves.status : 'synced',
    ...rowQueues.map((q) => (q.queuedCount > 0 ? q.status : 'synced')),
    settingsDirty ? settingsStatus : 'synced'
  ])
  const badgeQueued = queuedCount + moves.queuedCount + rowQueues.reduce((n, q) => n + q.queuedCount, 0)

  // Signed out on another device: this device's session is gone for good,
  // and only a new sign-in sends what waits here (see SyncNotices).
  const [reauth, setReauth] = useState(false)
  useEffect(() => {
    if (session) setReauth(false)
  }, [session])
  const sessionEnded = !loading && !session && Boolean(offlineUser) && !hasStoredSession()
  const unsavedCount =
    (sync.unsaved ? queuedCount : 0) +
    (moves.unsaved ? moves.queuedCount : 0) +
    (settingsUnsaved ? 1 : 0) +
    (sync.refusedUnsaved ? sync.refused.length : 0) +
    (moves.refusedUnsaved ? moves.refused.length : 0) +
    rowQueues.reduce((n, q) => n + (q.unsaved ? q.queuedCount : 0) + (q.refusedUnsaved ? q.refused.length : 0), 0)
  const refusedList = [...sync.refused, ...moves.refused, ...expenses.refused, ...cards.refused, ...budgets.refused]

  // Amounts show in units when the user has a unit size and asked for them.
  const unit = effectiveUnit(settings)
  const money = useMemo(() => moneyFormat(unit), [unit])
  // The expenses have their own currency (never units, never the bets' dollars): their subtree gets this instead.
  const expenseMoney = useMemo(() => currencyFormat(settings.expenseCurrency), [settings.expenseCurrency])

  // The bankroll is a balance over every bet, whatever the range. Until both
  // the settings (for the starting bankroll) and the deposits and withdrawals
  // have loaded on this device, it is not known, rather than wrong.
  const bankroll = useMemo(
    () => bankrollNow(bets ?? [], moves.loaded ? moves.moves : null, settingsLoaded ? settings.startingBankroll : undefined),
    [bets, moves.loaded, moves.moves, settingsLoaded, settings.startingBankroll]
  )

  useEffect(() => {
    if (!loading && (!activeUserId || bets !== null)) {
      document.documentElement.dataset.ready = '1'
    }
  }, [loading, activeUserId, bets])

  // P/L, ROI, the chart and the advanced numbers (breakdown included) follow
  // the chosen date range; the bankroll, the pending bets, the calendar, the
  // month card and the history always see everything (the history can be
  // narrowed to the range). Each card says which (see Scope).
  const [range, setRange] = useState<DateRange>(loadRange)
  const changeRange = useCallback((next: DateRange) => {
    setRange(next)
    saveRange(next)
  }, [])
  const ranged = useMemo(() => filterRange(bets ?? [], range, todayStr()), [bets, range])
  const scoped = useMemo(() => summarize(ranged), [ranged])
  const rangeName = range.kind === 'all' ? null : t(`range.${range.kind}`)
  const historyRange = useMemo(() => (rangeName === null ? null : { name: rangeName, bounds: rangeBounds(range, todayStr()) }), [range, rangeName])

  const dayMap = useMemo(() => {
    const map = new Map<string, DaySummary>()
    for (const day of groupByDay(bets ?? [])) map.set(day.date, day)
    return map
  }, [bets])

  const suggestions = useMemo<TagSuggestions>(
    () => ({
      sport: tagValues(bets ?? [], 'sport'),
      book: tagValues(bets ?? [], 'book'),
      betType: tagValues(bets ?? [], 'betType')
    }),
    [bets]
  )

  const modalBets = day ? (dayMap.get(day.date)?.bets ?? []) : []

  // Unfinished forms, kept per user (see data/drafts.ts).
  // What the quick add holds now: closing it with something typed says it is kept.
  const quickDraft = useRef<QuickDraft | null>(null)
  const openQuick = useCallback(() => {
    const draft = activeUserId ? loadQuickDraft(activeUserId) : null
    quickDraft.current = draft
    setQuickStart(draft)
    setQuickOpen(true)
  }, [activeUserId, quickDraft])
  const dayDrafts = useMemo<DayDrafts>(
    () => ({
      load: (date, editingId) => (activeUserId ? loadDayDraft(activeUserId, date, editingId) : null),
      save: (id, draft) => {
        if (activeUserId) saveDayDraft(activeUserId, id, draft)
      }
    }),
    [activeUserId]
  )
  const openList = useMemo(() => openBets(bets ?? [], todayStr()), [bets])

  // The monthly loss limit watches the current calendar month, whatever the
  // range or the calendar page. A dismissal is per month and level.
  const [lossDismissed, setLossDismissed] = useState<string | null>(loadLossDismissed)
  const thisMonth = currentMonth()
  const loss = useMemo(() => lossState(total(forMonth(bets ?? [], thisMonth)), settings.lossLimit), [bets, settings.lossLimit, thisMonth])
  const lossKey = dismissKey(thisMonth, loss.level)
  const dismissLoss = useCallback(() => {
    saveLossDismissed(lossKey)
    setLossDismissed(lossKey)
  }, [lossKey])

  // The + button and `T`: scanning a receipt starts from there too, with the sheet's own Scan receipt.
  const openExpense = useCallback(() => setExpenseSheet({ kind: 'add' }), [])
  // Every dialog, bets' and expenses': the keys and the + button stand aside while one is open (dialogs never stack).
  const anyDialogOpen = day !== null || quickOpen || settingsOpen || pendingOpen || bankrollOpen || dataOpen || expenseSheet !== null || expenseSettings !== null

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (anyDialogOpen) return
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      // The month is shared by both views.
      if (e.key === 'ArrowLeft') setYm((m) => addMonths(m, -1))
      if (e.key === 'ArrowRight') setYm((m) => addMonths(m, 1))
      if (e.key === 't' || e.key === 'T') {
        // The sheet focuses and selects the stake box as it opens; without this
        // the same keystroke's character would land there and wipe the default.
        e.preventDefault()
        if (view === 'expenses') openExpense()
        else openQuick()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [anyDialogOpen, view, openQuick, openExpense])

  // With the session ended the queue waits for a sign-in, not the connection.
  const savedNote = useCallback(
    (action: string, date?: string) => {
      // The day it is for, whatever else is said (offline, signed out).
      const what = date ? t('toast.onDate', { action, date: humanDate(date) }) : action
      return sessionEnded ? t('toast.signedOut', { action: what }) : isOffline ? t('toast.offline', { action: what }) : what
    },
    [sessionEnded, isOffline, t]
  )

  // Mutations apply instantly (optimistic) and sync in the background. The
  // toast says it is done only once storage holds the change: one that is
  // only in this window says so instead (see SyncNotices).
  const done = useCallback(
    (saved: boolean, text: string, undo?: () => Promise<boolean | null>) => {
      if (!saved) {
        setToast({ kind: 'error', text: t('toast.notSaved') })
        return
      }
      if (!undo) {
        setToast({ kind: 'ok', text })
        return
      }
      // An offer to put things back. The undo goes through the outbox too, so it works offline.
      let clicked = false
      setToast({
        kind: 'ok',
        text,
        action: {
          label: t('toast.undo'),
          onClick: () => {
            // Once: a second click while the first is on its way would do it twice.
            if (clicked) return
            clicked = true
            undo().then((kept) => {
              // null: it said what happened itself (not yet, already done).
              if (kept === null) return
              setToast(kept ? { kind: 'ok', text: savedNote(t('toast.undone')) } : { kind: 'error', text: t('toast.notSaved') })
            }, showError)
          }
        }
      })
    },
    [savedNote, showError, t]
  )

  // From a form: a refused bet throws, and the form says why with
  // everything typed still in it (see refusalText). Accepted, the toast says
  // so (or that it is only in this window).
  const handleAdd = useCallback(
    async (input: BetInput): Promise<void> => {
      const saved = await sync.addBet(input)
      done(saved, savedNote(t(input.status === 'pending' ? 'toast.loggedPending' : 'toast.added'), input.date))
    },
    [sync, savedNote, done, t]
  )

  const handleUpdate = useCallback(
    async (id: string, input: BetInput): Promise<void> => {
      const saved = await sync.updateBet(id, input)
      done(saved, savedNote(t('toast.updated'), input.date))
    },
    [sync, savedNote, done, t]
  )

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        const gone = (bets ?? []).find((b) => b.id === id)
        const saved = await sync.deleteBet(id)
        done(saved, savedNote(t('toast.deleted')), gone ? () => sync.restoreBets([gone]) : undefined)
      } catch (err) {
        showError(err)
      }
    },
    [bets, sync, savedNote, showError, done, t]
  )

  const handleBulkDelete = useCallback(
    async (ids: string[]) => {
      try {
        const wanted = new Set(ids)
        const gone = (bets ?? []).filter((b) => wanted.has(b.id))
        if (gone.length === 0) return
        const saved = await sync.deleteBets(gone.map((b) => b.id))
        done(saved, savedNote(t('toast.deletedN', { bets: tn('bet', gone.length) })), () => sync.restoreBets(gone))
      } catch (err) {
        showError(err)
      }
    },
    [bets, sync, savedNote, showError, done, t, tn]
  )

  const handleBulkRetag = useCallback(
    async (ids: string[], patch: TagPatch) => {
      try {
        const wanted = new Set(ids)
        const plan = retagPlan((bets ?? []).filter((b) => wanted.has(b.id)), patch)
        if (plan.next.length === 0) {
          setToast({ kind: 'ok', text: t('toast.retagNothing') })
          return
        }
        const saved = await sync.updateBets(plan.next)
        done(saved, savedNote(t('toast.retagged', { bets: tn('bet', plan.next.length) })), () => sync.updateBets(plan.prev))
      } catch (err) {
        showError(err)
      }
    },
    [bets, sync, savedNote, showError, done, t, tn]
  )

  const handleBulkSettle = useCallback(
    async (ids: string[], status: Exclude<BetStatus, 'pending'>) => {
      try {
        const wanted = new Set(ids)
        const plan = settlePlan((bets ?? []).filter((b) => wanted.has(b.id)), status)
        const skipped = plan.skipped > 0 ? t('toast.settleSkipped', { n: plan.skipped }) : ''
        if (plan.next.length === 0) {
          setToast({ kind: 'ok', text: t('toast.settleNone') + skipped })
          return
        }
        const saved = await sync.updateBets(plan.next)
        done(
          saved,
          savedNote(t('toast.settledN', { bets: tn('bet', plan.next.length), status: t(`statusWord.${status}`) }) + skipped),
          () => sync.updateBets(plan.prev)
        )
      } catch (err) {
        showError(err)
      }
    },
    [bets, sync, savedNote, showError, done, t, tn]
  )

  // Settling from the history table: when the result follows from stake and
  // odds it's one tap; when it doesn't (no odds on a win, a free bet's win, a
  // profit that rounds to $0.00), the bet opens in its day's form, as won, so
  // the user can type it.
  const handleSettle = useCallback(
    async (bet: Bet, next: BetStatus, amount: number | null) => {
      // A result that can't be worked out is typed in the bet's form: a win
      // without odds, a loss without a stake (a casino play may have none).
      if ((next === 'won' && (amount === null || amount === 0)) || (next === 'lost' && amount === null)) {
        setDay({ date: bet.date, edit: { id: bet.id, as: next } })
        return
      }
      try {
        const saved = await sync.updateBet(bet.id, {
          date: bet.date,
          amount,
          stake: bet.stake,
          odds: bet.odds,
          closingOdds: bet.closingOdds,
          status: next,
          note: bet.note,
          sport: bet.sport,
          book: bet.book,
          betType: bet.betType
        })
        done(saved, savedNote(t('toast.settled', { status: t(`statusWord.${next}`) }), bet.date))
      } catch (err) {
        showError(err)
      }
    },
    [sync, savedNote, showError, done, t]
  )

  // Deposits and withdrawals. The toast names the kind (in Spanish an ingreso
  // and a retirada take different endings).
  const handleAddMove = useCallback(
    async (input: MoveInput) => {
      try {
        const saved = await moves.addMove(input)
        done(saved, savedNote(t(kindOf(input.amount) === 'deposit' ? 'toast.depositAdded' : 'toast.withdrawalAdded'), input.date))
      } catch (err) {
        showError(err)
      }
    },
    [moves, savedNote, showError, done, t]
  )

  const handleUpdateMove = useCallback(
    async (id: string, input: MoveInput) => {
      try {
        const saved = await moves.updateMove(id, input)
        done(saved, savedNote(t(kindOf(input.amount) === 'deposit' ? 'toast.depositUpdated' : 'toast.withdrawalUpdated'), input.date))
      } catch (err) {
        showError(err)
      }
    },
    [moves, savedNote, showError, done, t]
  )

  const handleDeleteMove = useCallback(
    async (m: BankrollMove) => {
      try {
        const saved = await moves.deleteMove(m.id)
        done(saved, savedNote(t(kindOf(m.amount) === 'deposit' ? 'toast.depositDeleted' : 'toast.withdrawalDeleted')), () => moves.restoreMove(m))
      } catch (err) {
        showError(err)
      }
    },
    [moves, savedNote, showError, done, t]
  )

  // ---- Expenses (each queued like a move; the sheets say why one is refused) ----

  const handleAddExpense = useCallback(
    async (input: ExpenseInput): Promise<void> => {
      const { saved, id } = await expenses.add(input)
      // The card and category for next time, and the currency when it was paid in another one.
      if (activeUserId) saveExpenseLast(activeUserId, { cardId: input.cardId ?? null, category: toCategory(input.category), ...(input.originalCurrency ? { currency: input.originalCurrency } : {}) })
      done(saved, savedNote(t(input.amount < 0 ? 'toast.refundAdded' : 'toast.expenseAdded'), input.date), () => expenses.remove(id))
    },
    [expenses, activeUserId, done, savedNote, t]
  )

  const handleAddExpenses = useCallback(
    async (inputs: ExpenseInput[]): Promise<void> => {
      const { saved, ids } = await expenses.addMany(inputs)
      // A picture in another currency: offered first the next time.
      const paidIn = inputs.find((i) => i.originalCurrency)?.originalCurrency
      if (activeUserId && paidIn) rememberPayCurrency(activeUserId, paidIn)
      const message = ids.length === 1 ? t('toast.expenseAdded') : t('toast.expensesAdded', { expenses: tn('expense', ids.length) })
      done(saved, savedNote(message), () => expenses.removeMany(ids))
    },
    [expenses, activeUserId, done, savedNote, t, tn]
  )

  const handleUpdateExpense = useCallback(
    async (id: string, input: ExpenseInput): Promise<void> => {
      done(await expenses.update(id, input), savedNote(t('toast.expenseUpdated'), input.date))
    },
    [expenses, done, savedNote, t]
  )

  const handleDeleteExpense = useCallback(
    async (e: Expense): Promise<void> => {
      try {
        done(await expenses.remove(e.id), savedNote(t('toast.expenseDeleted')), () => expenses.restore(e))
      } catch (err) {
        showError(err)
      }
    },
    [expenses, done, savedNote, showError, t]
  )

  const handleSaveCard = useCallback(
    async (input: ExpenseCardInput, id?: string): Promise<void> => {
      if (id) {
        await cards.update(id, input)
        return
      }
      const added = await cards.add(input)
      // Handed over from the expense sheet: the card added comes back chosen.
      if (resumeRef.current) resumeRef.current.addedCardId = added.id
    },
    [cards]
  )

  const handleDeleteCard = useCallback(
    async (card: ExpenseCard): Promise<void> => {
      try {
        const mode = cardDeleteMode(card, expenses.rows, { loaded: expenses.loaded, readThisSession: expenses.tableReady })
        // Its budget goes with it, and comes back with an Undo.
        const budget = budgets.rows.find((b) => b.scope === 'card' && b.target.toLowerCase() === card.id.toLowerCase()) ?? null
        if (budget) {
          budgetSeen.current.set(budget.id, budget.updatedAt)
          await budgets.remove(budget.id)
        }
        const undoBudget = budget ? () => budgets.restore(budget) : null
        const back = (archived: boolean) => ({ ...CARDS_SPEC.toInput(card), archived })
        if (mode === 'archive') {
          done(await cards.update(card.id, back(true)), savedNote(t('toast.cardArchived', { name: card.name })), () =>
            Promise.all([cards.update(card.id, back(false)), undoBudget?.()]).then((r) => r.every((x) => x !== false))
          )
        } else {
          done(await cards.remove(card.id), savedNote(t('toast.cardDeleted', { name: card.name })), () =>
            Promise.all([cards.restore(card), undoBudget?.()]).then((r) => r.every((x) => x !== false))
          )
        }
      } catch (err) {
        showError(err)
      }
    },
    [cards, budgets, expenses.rows, expenses.loaded, expenses.tableReady, done, savedNote, showError, t]
  )

  const handleRestoreCard = useCallback(
    async (card: ExpenseCard): Promise<void> => {
      try {
        await cards.update(card.id, { ...CARDS_SPEC.toInput(card), archived: false })
      } catch (err) {
        showError(err)
      }
    },
    [cards, showError]
  )

  // The newest stamp seen of each budget: a budget cleared and set again is stamped after it (see useRowSync's `after`).
  useEffect(() => {
    for (const b of budgets.rows) {
      const seen = budgetSeen.current.get(b.id)
      if (!seen || seen < b.updatedAt) budgetSeen.current.set(b.id, b.updatedAt)
    }
  }, [budgets.rows])
  // The expense being edited went away (deleted on another device): its sheet closes.
  const editGone = expenseSheet?.kind === 'edit' && expenses.loaded && !expenses.rows.some((e) => e.id === expenseSheet.id)
  useEffect(() => {
    if (editGone) setExpenseSheet(null)
  }, [editGone])
  // Another account here: nothing of the last one's handover or stamps carries over.
  useEffect(() => {
    resumeRef.current = null
    budgetSeen.current = new Map()
  }, [activeUserId])

  /** A monthly budget set (a number) or cleared (null). Only once the budgets have loaded and 008 is proven. */
  const handleSetBudget = useCallback(
    async (scope: BudgetScope, target: string, limit: number | null): Promise<void> => {
      const uid = activeUserId
      if (!uid || !budgets.loaded || !has008) return
      try {
        // By (scope, target), not by budgetId: a row adopted under another id is still this budget.
        const row = budgets.rows.find((b) => b.scope === scope && b.target === target) ?? null
        if (limit === null) {
          if (!row) return
          budgetSeen.current.set(row.id, row.updatedAt)
          await budgets.remove(row.id)
          return
        }
        // Unchanged: never re-stamp a value.
        if (row && Math.round(row.monthlyLimit * 100) === Math.round(limit * 100)) return
        const input = { scope, target, monthlyLimit: limit }
        if (row) await budgets.update(row.id, input)
        else {
          const id = budgetId(uid, scope, target)
          await budgets.add(input, { id, after: budgetSeen.current.get(id) })
        }
      } catch (err) {
        showError(err)
      }
    },
    [activeUserId, budgets, has008, showError]
  )

  const handleSetCurrency = useCallback(
    (code: string): void => {
      const before = settings.expenseCurrency
      if (code === before || !settingsLoaded || !has008) return
      void updateSettings({ expenseCurrency: code })
      setToast({
        kind: 'ok',
        text: t('toast.currencyChanged', { currency: code }),
        action: { label: t('toast.undo'), onClick: () => void updateSettings({ expenseCurrency: before }) }
      })
    },
    [settings.expenseCurrency, settingsLoaded, has008, updateSettings, setToast, t]
  )

  const handleExportExpenses = useCallback(() => {
    if (!expenses.loaded || !cards.loaded || !settingsLoaded || expenses.rows.length === 0) return
    const n = downloadExpensesCsv(expenses.rows, cards.rows, settings.expenseCurrency)
    setToast({ kind: 'ok', text: t('toast.expensesExported', { expenses: tn('expense', n) }) })
  }, [expenses.loaded, expenses.rows, cards.loaded, cards.rows, settingsLoaded, settings.expenseCurrency, setToast, t, tn])

  /** One AI reading: the image, today, the language, the currency and the active cards' names and last digits (never their ids). */
  const runExtract = useCallback(
    // Loaded with the first scan: the reading's checks stay out of the boot bundle.
    (image: PreparedImage, signal: AbortSignal): Promise<ExtractOutcome> =>
      import('./data/extract').then(
        ({ extractExpenses }) =>
          extractExpenses(
            {
              v: 1,
              image: { mediaType: image.mediaType, data: image.base64 },
              today: todayStr(),
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
              lang: getLang(),
              currency: settingsLoaded ? settings.expenseCurrency : null,
              cards: cards.rows.filter((c) => !c.archived).map((c) => ({ name: c.name, last4: c.last4, kind: c.kind }))
            },
            { signal, asUser: activeUserId ?? undefined }
          ),
        // The code itself didn't load (offline before it was ever cached).
        (): ExtractOutcome => ({ ok: false, code: 'network' })
      ),
    [settingsLoaded, settings.expenseCurrency, cards.rows, activeUserId]
  )

  // What the Bankroll dialog's changes wait for, judged per queue: a
  // migration for the queue it holds back, the connection for the rest. A
  // change simply on its way says nothing.
  const firstBet = bankroll.firstBetDate
  const movesWaiting = moves.queuedCount > 0
  const bankrollSyncNote =
    (movesWaiting && moves.blocked) || (settingsDirty && settingsBlocked)
      ? 'blocked'
      : (movesWaiting || settingsDirty) && (isOffline || moves.status === 'offline')
        ? 'offline'
        : null

  const openBankroll = useCallback(() => {
    setSettingsOpen(false)
    setBankrollOpen(true)
  }, [])

  const handleExport = useCallback(() => {
    if (!bets || bets.length === 0) return
    const count = downloadCsv(bets)
    setToast({ kind: 'ok', text: t('toast.exported', { bets: tn('bet', count) }) })
  }, [bets, t, tn])

  // The expenses, cards and budgets go in the file too (DataDialog offers the
  // download only once they have loaded: its `backupReady`).
  const handleBackup = useCallback(() => {
    if (!activeUserId || !bets) return
    const backup = makeBackup(bets, moves.moves, settings, { id: activeUserId, email: activeEmail }, new Date(), {
      expenses: expenses.rows,
      expenseCards: cards.rows,
      expenseBudgets: budgets.rows
    })
    downloadBackup(backup)
    setToast({ kind: 'ok', text: t('backup.downloaded', { bets: tn('bet', backup.bets.length), moves: tn('move', backup.moves.length) }) })
  }, [activeUserId, activeEmail, bets, moves.moves, settings, expenses.rows, cards.rows, budgets.rows, t, tn])

  // The latest copy, for an Undo clicked long after the change it undoes.
  const betsRef = useRef(bets)
  betsRef.current = bets
  const movesRef = useRef(moves.moves)
  movesRef.current = moves.moves
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const refreshBatches = useCallback(() => setBatches(activeUserId ? loadImports(activeUserId) : []), [activeUserId])
  // Another window recorded or undid a batch, or heard what the server made of one.
  useEffect(() => {
    refreshBatches()
    if (!activeUserId) return
    const onStorage = (e: StorageEvent): void => {
      if (e.key === null || e.key === `bettracker:imports:${activeUserId}`) refreshBatches()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [activeUserId, refreshBatches])

  // Where a batch stands now, for the restore's result (see lib/batchStatus.ts).
  const batchLive = useCallback(
    (b: ImportBatch): BatchLive => ({
      bets: sync.batchQueued.get(b.id) ?? NONE_QUEUED,
      moves: moves.batchQueued.get(b.id) ?? NONE_QUEUED,
      betsHeld: sync.held,
      movesHeld: moves.held,
      refused: sync.batchRefused.has(b.id) || moves.batchRefused.has(b.id),
      settingsOrigins,
      settingsHeld
    }),
    [sync.batchQueued, sync.batchRefused, sync.held, moves.batchQueued, moves.batchRefused, moves.held, settingsOrigins, settingsHeld]
  )
  const batchLiveRef = useRef(batchLive)
  batchLiveRef.current = batchLive

  // What an operation needs of the app (see data/operations.ts): for one
  // user, always through the latest hooks.
  const syncRef = useRef(sync)
  syncRef.current = sync
  const movesHookRef = useRef(moves)
  movesHookRef.current = moves
  const settingsLoadedRef = useRef(settingsLoaded)
  settingsLoadedRef.current = settingsLoaded
  const updateSettingsRef = useRef(updateSettings)
  updateSettingsRef.current = updateSettings
  const settingsQueueRef = useRef(settingsQueueFresh)
  settingsQueueRef.current = settingsQueueFresh
  const portsFor = useCallback(
    (uid: string): OperationPorts => ({
      userId: uid,
      active: () => activeUserRef.current === uid,
      history: { fresh: () => freshImports(uid), change: (id, fn) => changeImport(uid, id, fn) },
      bets: {
        queue: () => syncRef.current.queueFresh(),
        add: (payload, o) => syncRef.current.queueBatch(payload, o),
        remove: async (targets, batch) => ({ saved: await syncRef.current.undoBets(targets, batch) })
      },
      moves: {
        queue: () => movesHookRef.current.queueFresh(),
        add: (payload, o) => movesHookRef.current.queueBatch(payload, o),
        remove: async (targets, batch) => ({ saved: await movesHookRef.current.undoMoves(targets, batch) })
      },
      settings: { pending: () => settingsQueueRef.current(), write: (patch, o) => updateSettingsRef.current(patch, o) },
      shown: (list) => {
        if (activeUserRef.current === uid) setBatches(list)
      }
    }),
    []
  )

  // Operations a window left written down but not queued (closed or reloaded
  // in between): queued now, and every little while, by one window at a time.
  useEffect(() => {
    if (!activeUserId) return
    const uid = activeUserId
    const go = (): void => void resumeOperations(portsFor(uid)).catch(() => undefined)
    go()
    const timer = setInterval(go, RESUME_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [activeUserId, portsFor])

  /**
   * Undo a whole import or restore. It removes only what the batch wrote and
   * nobody changed since: the rows that still carry its stamp, checked here
   * (for what the toast says) and again by the server in the same statement
   * as the delete (see deleteBet), so a row that was there before, another
   * device's, or one edited since anywhere, stays. The settings a restore
   * replaced go back where they still hold the backup's value, here and on
   * the server (see PendingSettings.guard). Written down first and then
   * queued, as the batch was (see data/operations.ts). Itself undoable: the
   * toast puts back what it removed, with its ids, under a new stamp.
   *
   * An entry from before batches had stamps: an import's rows each count as
   * unchanged at the stamp this device last saw; a restore's can't be told
   * from what was there before, so its Undo is not offered (see DataDialog).
   */
  const undoBatch = useCallback(
    async (batch: ImportBatch): Promise<boolean | null> => {
      const uid = activeUserId
      if (!uid) return false
      const first = (await freshImports(uid)).find((b) => b.id === batch.id) ?? batch
      // Planned against the data as it is here: not before what it touches has
      // loaded (an empty list, or the default settings, would read as "gone"
      // or "changed since").
      const touches = {
        bets: first.ids.length > 0,
        moves: (first.moveIds ?? []).length > 0,
        settings: Object.keys(first.restore?.settings?.after ?? {}).length > 0
      }
      if ((touches.bets && betsRef.current === null) || (touches.moves && !movesHookRef.current.loaded) || (touches.settings && !settingsLoadedRef.current)) {
        setToast({ kind: 'ok', text: t('undo.notLoaded') })
        return null
      }
      if (first.undone) {
        setToast({ kind: 'ok', text: t('undo.already') })
        return null
      }
      if (!first.stamp && first.kind === 'restore') return false
      const at = new Date().toISOString()
      type Plan = { why: 'wait' | 'already' | null; undo?: NonNullable<ImportBatch['undo']>; bets: Bet[]; moves: BankrollMove[]; changedHere: number }
      // What to take back, from the entry as it is under the operation's lock:
      // a second click, or another window, that got there first leaves it as
      // it is (see continueOperation).
      const decide = (entry: ImportBatch): Plan => {
        if (entry.undone) return { why: 'already', bets: [], moves: [], changedHere: 0 }
        // A part not queued yet would be queued after the Undo, and stay: it waits for it.
        if (preparedParts(entry).some((p) => p === 'bets' || p === 'moves' || p === 'settings')) return { why: 'wait', bets: [], moves: [], changedHere: 0 }
        const stampOf = (row: { updatedAt: string }): string => entry.stamp ?? row.updatedAt
        const here = new Map((betsRef.current ?? []).map((b) => [b.id, b]))
        const hereMoves = new Map(movesRef.current.map((m) => [m.id, m]))
        let goneHere = 0
        let changedHere = 0
        const bets: Bet[] = []
        const moves: BankrollMove[] = []
        for (const id of entry.ids) {
          const row = here.get(id)
          if (!row) goneHere++
          else if (sameStamp(row.updatedAt, stampOf(row))) bets.push(row)
          else changedHere++
        }
        for (const id of entry.moveIds ?? []) {
          const row = hereMoves.get(id)
          if (!row) goneHere++
          else if (sameStamp(row.updatedAt, stampOf(row))) moves.push(row)
          else changedHere++
        }
        // Settings: back where they still hold what the restore set (see undoSettingsLog).
        const settingsPlan = undoSettingsLog(entry.restore?.settings, settingsRef.current as unknown as Partial<Record<SettingsField, unknown>>, at)
        return {
          why: null,
          bets,
          moves,
          changedHere,
          undo: {
            at,
            stamp: entry.stamp ?? '',
            ...(entry.stamp ? {} : { stamps: Object.fromEntries([...bets, ...moves].map((r) => [r.id, r.updatedAt])) }),
            phase: bets.length + moves.length > 0 ? 'prepared' : 'queued',
            bets: bets.map((r) => r.id),
            moves: moves.map((r) => r.id),
            changedHere,
            goneHere,
            removed: [],
            kept: [],
            ...(settingsPlan.settings ? { settings: settingsPlan.settings } : {})
          }
        }
      }
      // Decided once, the first time: a history storage refused replays the
      // change on later writes (see store.ts), after the rows are gone here.
      let decided: Plan | null = null
      const plan = (entry: ImportBatch): ImportBatch => {
        const d = (decided ??= decide(entry))
        return d.undo && !entry.undone ? { ...entry, undone: true, undo: d.undo } : entry
      }
      const ports = portsFor(uid)
      const after = await continueOperation(ports, first.id, plan)
      const d = decided as Plan | null
      if (!d || !after?.undone || after.undo?.at !== at) {
        setToast({ kind: 'ok', text: t(d?.why === 'wait' ? 'undo.wait' : 'undo.already') })
        return null
      }
      const { bets: goneBets, moves: goneMoves, changedHere } = d
      // Its adds the server refused would, sent again, put back what it took out.
      await Promise.all([syncRef.current.discardBatchRefused(first.id), movesHookRef.current.discardBatchRefused(first.id)])
      // The settings as queued (a change of the user's own still pending keeps one: see queuePart).
      const us = after.undo.settings
      const keptNow = [...(us?.kept ?? []), ...(us?.rejected ?? [])]
      const reverted = (us?.asked ?? []).filter((f) => !keptNow.includes(f))
      const keptFields = [...new Set([...(us?.keptHere ?? []), ...(us?.kept ?? [])])]
      if (goneBets.length === 0 && goneMoves.length === 0 && reverted.length === 0) {
        setToast({ kind: 'ok', text: t(changedHere > 0 || keptFields.length > 0 ? 'undo.allChanged' : after.kind === 'restore' ? 'undo.restoreNothing' : 'imp.undoNothing') })
        return null
      }
      const saved = after.undo.phase !== 'held' && us?.phase !== 'held'
      const parts = [
        after.kind === 'restore'
          ? t('undo.restoreRemoved', { bets: tn('bet', goneBets.length), moves: tn('move', goneMoves.length) })
          : t('imp.undone', { bets: tn('bet', goneBets.length) }),
        changedHere > 0 ? t('undo.changedKept', { n: changedHere }) : '',
        reverted.length > 0 ? t('undo.settingsBack', { fields: reverted.map((f) => t(`settingName.${f}`)).join(', ') }) : '',
        keptFields.length > 0 ? t('undo.settingsKept', { fields: keptFields.map((f) => t(`settingName.${f}`)).join(', ') }) : ''
      ]
      done(saved, savedNote(parts.filter(Boolean).join(' · ')), async () => {
        // Put back what it removed, all under one new stamp: the next Undo
        // takes them by it (see readdStamp for why it is new). Written down,
        // then queued, as the batch was; only over this Undo (a second click,
        // or one undone again since, leaves the entry as it is). Decided
        // once, as the Undo was.
        const stamp = readdStamp([...goneBets, ...goneMoves])
        const now = new Date().toISOString()
        let applied: boolean | null = null
        const back = await continueOperation(portsFor(uid), first.id, (b) => {
          applied ??= b.undone === true && b.undo?.at === at
          if (!applied) return b
          return redoBatch(b, {
            stamp,
            now,
            bets: goneBets.map((r) => ({ id: r.id, input: toInput(r) })),
            moves: goneMoves.map((m) => ({ id: m.id, input: { date: m.date, amount: m.amount, note: m.note } })),
            reverted
          })
        })
        if (!applied) {
          setToast({ kind: 'ok', text: t('undo.already') })
          return null
        }
        return back?.parts?.bets?.phase !== 'held' && back?.parts?.moves?.phase !== 'held' && back?.restore?.settings?.phase !== 'held'
      })
      // It said what happened itself (with the offer to put it back): the
      // caller adds nothing (see done).
      return null
    },
    [activeUserId, portsFor, done, savedNote, t, tn]
  )

  // From the review step: what the user chose to import, against the bets as
  // they are now. Bets that changed since the review change the plan: the
  // review shows the new one instead. Checked whole first (a row that can't
  // go in fails the import before anything is written down), then written
  // down and queued (see data/operations.ts). Throws when refused.
  const handleImport = useCallback(
    async (choice: ImportChoice): Promise<ImportOutcome> => {
      const uid = activeUserId
      if (!uid) return { kind: 'done' }
      const plan = planImport(choice.parsed, betsRef.current ?? [])
      if (plan.signature !== choice.signature) return { kind: 'changed', plan }
      const keep = new Set(choice.keepLines)
      const rows = [...plan.fresh, ...plan.duplicates.filter((d) => keep.has(d.line))].sort((a, b) => a.line - b.line)
      const skipped = plan.duplicates.length - plan.duplicates.filter((d) => keep.has(d.line)).length
      const payload = rows.map((r) => ({ id: newId(), input: normalizeInput(r.input) }))
      const at = new Date().toISOString()
      const batch: ImportBatch = {
        id: newId(),
        at,
        file: choice.file,
        fingerprint: choice.fingerprint,
        ids: payload.map((p) => p.id),
        stamp: at,
        parts: { bets: { phase: 'prepared', payload } }
      }
      const notes = (skipped > 0 ? t('imp.doneSkipped', { n: skipped }) : '') + (plan.rejected.length > 0 ? t('imp.doneRejected', { n: plan.rejected.length }) : '')
      if (payload.length === 0) {
        done(true, savedNote(t('imp.done', { bets: tn('bet', 0) }) + notes))
        return { kind: 'done' }
      }
      let after: ImportBatch | undefined
      try {
        after = await startOperation(portsFor(uid), batch)
      } catch (err) {
        if (err instanceof HistoryFullError) throw new StorageWriteError(err)
        throw err
      }
      const saved = after?.parts?.bets?.phase !== 'held'
      if (after?.parts?.bets?.phase === 'failed') throw new Error(after.parts.bets.error ?? t('common.error'))
      done(saved, savedNote(t('imp.done', { bets: tn('bet', payload.length) }) + notes), () => undoBatch(batch))
      return { kind: 'done' }
    },
    [activeUserId, portsFor, done, savedNote, undoBatch, t, tn]
  )

  /**
   * A backup, as reviewed. The plan is made again from the data as it is now
   * first: another device or window may have changed it during the review,
   * and then the review shows the new plan instead of applying the old one.
   * Every part is checked, then written down with what it is to queue, then
   * queued (see data/operations.ts): a restore that stops halfway (a reload,
   * a closed window) goes on by itself, once, and says what is missing. A
   * restore only adds (see planRestore), and the server leaves a row it
   * already has as it is (see addBets).
   */
  const handleRestore = useCallback(
    async (choice: RestoreChoice): Promise<RestoreOutcome> => {
      const uid = activeUserId
      if (!uid) return { kind: 'nothing' }
      const now = { userId: uid, bets: betsRef.current ?? [], moves: movesRef.current, settings: settingsRef.current, currencyWritable: has008 }
      const fresh = planRestore(choice.backup, now, newId)
      if (fresh.signature !== choice.plan.signature) return { kind: 'changed', plan: fresh }
      const { plan } = choice
      const keep = new Set(choice.keepSources)
      const dups = plan.duplicateBets.filter((_, i) => keep.has(plan.duplicateSources[i]))
      const add = [...plan.newBets, ...dups]
      const replaced = choice.replaceSettings ? settingsChange(settingsRef.current, plan.settings) : null
      if (add.length === 0 && plan.newMoves.length === 0 && !replaced) return { kind: 'nothing' }
      // Every row checked before anything is written down.
      const bets = add.map((b) => ({ id: b.id, input: normalizeInput(toInput(b)) }))
      const movesPayload = plan.newMoves.map((m) => ({ id: m.id, input: normalizeMove({ date: m.date, amount: m.amount, note: m.note }) }))

      const stamp = new Date().toISOString()
      const entry: ImportBatch = {
        id: newId(),
        kind: 'restore',
        at: stamp,
        file: choice.file,
        fingerprint: choice.fingerprint,
        ids: bets.map((b) => b.id),
        moveIds: movesPayload.map((m) => m.id),
        stamp,
        parts: {
          ...(bets.length > 0 ? { bets: { phase: 'prepared' as const, payload: bets } } : {}),
          ...(movesPayload.length > 0 ? { moves: { phase: 'prepared' as const, payload: movesPayload } } : {})
        },
        restore: {
          skippedBets: plan.sameBets + plan.changedBets,
          skippedMoves: plan.sameMoves + plan.changedMoves,
          skippedDuplicates: plan.duplicateBets.length - dups.length,
          ...(replaced ? { settings: { ...replaced, editedAt: stamp, phase: 'prepared' as const } } : {}),
          failed: [],
          held: []
        }
      }
      try {
        await startOperation(portsFor(uid), entry)
      } catch (err) {
        if (err instanceof HistoryFullError) throw new StorageWriteError(err)
        throw err
      }
      return { kind: 'done', batch: entry.id }
    },
    [activeUserId, portsFor, has008]
  )

  /**
   * Check again: ask the server about what a batch has no answer for. A row
   * that carries the batch's stamp was made by it; another one was there
   * already; none, it is not there. An Undo's row still there as the batch
   * wrote it goes out again (its removal never reached the server); gone, it
   * was removed; changed, it was kept. Settings: as checkSettings says. An
   * entry from before batches had stamps has nothing to ask about its rows.
   */
  const checkBatch = useCallback(
    async (b: ImportBatch): Promise<void> => {
      const uid = activeUserId
      if (!uid) return
      const ports = portsFor(uid)
      // Under the operation's lock: a window queuing it meanwhile (see
      // queueParts) would find answers for rows it has not sent yet.
      await withOperation(uid, b.id, async () => {
        const entry = (await freshImports(uid)).find((x) => x.id === b.id)
        if (!entry) return
        const inQueue = async (table: 'bets' | 'moves', undo: boolean): Promise<Set<string>> => {
          const queue = await (table === 'bets' ? ports.bets.queue() : ports.moves.queue())
          const ids = new Set<string>()
          for (const op of queue) {
            const of = batchOf(op)
            if (!of || of.batch !== entry.id || of.undo !== undo) continue
            if (op.kind === 'bulk-add') op.entries.slice(op.done ?? 0).forEach((e) => ids.add(e.id))
            else if (op.kind !== 'update') ids.add(op.id)
          }
          return ids
        }
        const stamp = entry.stamp
        for (const table of ['bets', 'moves'] as const) {
          // Undone, or from before batches had stamps (its rows carry no receipt): nothing to ask.
          if (entry.undone || stamp === undefined) continue
          // Not queued yet: the resume sends it (asked now, none would be there).
          if (entry.parts?.[table]?.phase === 'prepared') continue
          const queued = await inQueue(table, false)
          // No answer yet, or not there when last asked (it may be by now).
          const missing = (table === 'bets' ? entry.missing : entry.missingMoves) ?? []
          const open = [...new Set([...unanswered(entry, table), ...missing])].filter((id) => !queued.has(id))
          if (open.length === 0) continue
          const stamps = await rowStamps(table === 'bets' ? 'entries' : 'bankroll_moves', open)
          const made = open.filter((id) => stamps.has(id) && sameStamp(stamps.get(id) as string, stamp))
          const present = open.filter((id) => stamps.has(id) && !made.includes(id))
          const gone = open.filter((id) => !stamps.has(id))
          setBatches(await recordBatchEvent(uid, { kind: 'outcome', batch: entry.id, table, stamp, made, present, missing: gone }))
        }
        const u = entry.undo
        // An Undo from before it kept the stamps it asked at has nothing to compare with.
        if (u && u.phase !== 'prepared' && (u.stamp || u.stamps)) {
          const answered = new Set([...u.removed, ...u.kept, ...(u.failed ?? [])])
          let again = false
          for (const table of ['bets', 'moves'] as const) {
            const queued = await inQueue(table, true)
            const open = (table === 'bets' ? u.bets : u.moves).filter((id) => !answered.has(id) && !queued.has(id))
            if (open.length === 0) continue
            const stamps = await rowStamps(table === 'bets' ? 'entries' : 'bankroll_moves', open)
            for (const id of open) {
              const found = stamps.get(id)
              const asked = u.stamps?.[id] ?? u.stamp
              if (found === undefined) setBatches(await recordBatchEvent(uid, { kind: 'undo', batch: entry.id, table, stamp: asked, id, removed: true }))
              else if (sameStamp(found, asked)) again = true
              else setBatches(await recordBatchEvent(uid, { kind: 'undo', batch: entry.id, table, stamp: asked, id, removed: false }))
            }
          }
          // Still there as the batch wrote them: their removal goes out again
          // (queued here, under the lock already held).
          if (again) {
            setBatches(await ports.history.change(entry.id, (x) => (x.undo && x.undo.at === u.at ? { ...x, undo: { ...x.undo, phase: 'prepared' } } : x)))
            await queueParts(ports, entry.id)
          }
        }
        const s = entry.restore?.settings
        const us = entry.undo?.settings
        const st = batchStatus(entry, batchLiveRef.current(entry))
        // Not queued yet: the resume writes them; there is nothing to ask the server.
        const settingsOpen = !entry.undone && s?.phase !== 'prepared' ? st.settings.unknown : []
        const undoOpen = us?.phase !== 'prepared' ? (st.undo?.settings?.unknown ?? []) : []
        if (s && (settingsOpen.length > 0 || undoOpen.length > 0)) {
          const row = await getSettings(uid)
          const defaults = DEFAULT_SETTINGS as unknown as Partial<Record<SettingsField, unknown>>
          const values = row as unknown as Partial<Record<SettingsField, unknown>> | null
          if (settingsOpen.length > 0) {
            const found = checkSettings(s, values, settingsOpen, false, defaults)
            setBatches(await recordBatchEvent(uid, { kind: 'settings', batch: entry.id, editedAt: s.editedAt, ...found }))
          }
          if (us && undoOpen.length > 0) {
            const found = checkSettings(s, values, undoOpen, true, defaults)
            setBatches(await recordBatchEvent(uid, { kind: 'settings', batch: entry.id, undo: true, editedAt: us.editedAt ?? entry.undo?.at, ...found }))
          }
        }
      })
    },
    [activeUserId, portsFor]
  )

  /** What a batch's recovery button does (see lib/batchStatus.ts); picking the file again is the dialog's. */
  const recoverBatch = useCallback(
    async (b: ImportBatch, action: RecoveryAction): Promise<void> => {
      const uid = activeUserId
      if (!uid) return
      const ports = portsFor(uid)
      try {
        if (action === 'resume') await withOperation(uid, b.id, () => queueParts(ports, b.id))
        else if (action === 'check') await checkBatch(b)
        else if (action === 'retrySettings') await continueOperation(ports, b.id, (x) => retrySettingsOf(x, new Date().toISOString()))
        else if (action === 'saveAgain') {
          const all = await Promise.all([sync.saveAgain(), moves.saveAgain(), expenses.saveAgain(), cards.saveAgain(), budgets.saveAgain(), saveSettingsAgain()])
          if (!all.every(Boolean)) setToast({ kind: 'error', text: t('toast.notSaved') })
        } else if (action === 'sendAgain') {
          await Promise.all([sync.retryRefused(), moves.retryRefused(), expenses.retryRefused(), cards.retryRefused(), budgets.retryRefused()])
        }
      } catch (err) {
        showError(err)
      }
    },
    [activeUserId, portsFor, checkBatch, sync, moves, expenses, cards, budgets, saveSettingsAgain, showError, t]
  )

  // Written down but not queued yet: lost if the user signs out before it goes on.
  const unqueued = useMemo(() => batches.reduce((n, b) => n + unqueuedOf(b), 0), [batches])

  if (loading) return <Boot />
  // Opened from a password reset email: the new password first.
  if (session && recovering) return <NewPassword />
  if (!activeUserId) return <Login />
  // Signing in again over this device's data: its queues wait meanwhile.
  if (reauth && !session) return <Login onCancel={() => setReauth(false)} />

  // No cached data yet: wait for the first fetch unless we're offline, in
  // which case show the (empty) app instead of blocking forever.
  const shownBets = bets ?? (isOffline ? [] : null)
  if (shownBets === null) return <Boot />

  // Why the AI reading can't start: it needs the server, and both lists (card matching, duplicates).
  const scanBlocked: 'offline' | 'signed_out' | 'loading' | null = sessionEnded
    ? 'signed_out'
    : !session || isOffline
      ? 'offline'
      : !cards.loaded || !expenses.loaded
        ? 'loading'
        : null
  const editingExpense = expenseSheet?.kind === 'edit' ? (expenses.rows.find((e) => e.id === expenseSheet.id) ?? null) : null
  const closeExpenseSettings = (): void => {
    setExpenseSettings(null)
    // Back to the sheet the card was added from, with what was typed and the new card chosen.
    const r = resumeRef.current
    if (r) {
      resumeRef.current = null
      setExpenseSheet({ kind: 'add', draft: r.draft, preferCardId: r.addedCardId ?? undefined })
    }
  }

  return (
    <MoneyContext.Provider value={money}>
      <div className="app" data-revisit={revisit ? '' : undefined}>
        <Header
          email={activeEmail}
          status={sessionEnded ? 'signedout' : badgeStatus}
          queuedCount={badgeQueued}
          pendingCount={openList.length}
          unsynced={badgeQueued + (settingsDirty ? 1 : 0) + refusedList.length + unqueued}
          theme={theme}
          onOpenData={() => {
            refreshBatches()
            setDataOpen(true)
          }}
          onToggleTheme={toggleTheme}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenExpenseSettings={() => setExpenseSettings('cards')}
          onOpenPending={() => setPendingOpen(true)}
          onSignOut={signOut}
        />

        {/* The one add button, on every screen: the open view's sheet (quick add, or an expense, whose sheet also
            scans). Fixed at the bottom right; here in the DOM so the keyboard meets it right after the menu button,
            where the header's Add bet was. Out of the way while a dialog is open: it would open another on top. */}
        {!anyDialogOpen && (
          <button
            type="button"
            className="fab"
            aria-label={t(view === 'bets' ? 'header.addBet' : 'header.addExpense')}
            title={t(view === 'bets' ? 'header.addBetTitle' : 'header.addExpenseTitle')}
            onClick={view === 'bets' ? openQuick : openExpense}
          >
            <PlusIcon size={22} />
          </button>
        )}

        <ViewTabs view={view} onChange={changeView} />

        <SyncNotices
          signedOut={sessionEnded ? badgeQueued + (settingsDirty ? 1 : 0) : null}
          unsaved={unsavedCount}
          refusalBlocked={sync.refusalBlocked || moves.refusalBlocked || expenses.refusalBlocked || cards.refusalBlocked || budgets.refusalBlocked}
          refused={refusedList.length > 0 ? { count: refusedList.length, reason: refusedList[0].reason } : null}
          onSignIn={() => setReauth(true)}
          onSaveAgain={() => {
            void Promise.all([sync.saveAgain(), moves.saveAgain(), expenses.saveAgain(), cards.saveAgain(), budgets.saveAgain(), saveSettingsAgain()]).then((all) => {
              if (!all.every(Boolean)) setToast({ kind: 'error', text: t('toast.notSaved') })
            })
          }}
          onRetryRefused={() => {
            void sync.retryRefused()
            void moves.retryRefused()
            for (const q of rowQueues) void q.retryRefused()
          }}
          onDiscardRefused={() => {
            void sync.discardRefused()
            void moves.discardRefused()
            for (const q of rowQueues) void q.discardRefused()
          }}
        />

        {view === 'bets' ? (
          <div className="view-panel bets-view" role="tabpanel" id="view-panel-bets" aria-labelledby="view-tab-bets" tabIndex={-1}>
            {loss.level !== 'none' && lossDismissed !== lossKey && <LossBanner state={loss} onChangeLimit={() => setSettingsOpen(true)} onDismiss={dismissLoss} />}

            {settingsLoaded && (
              <FirstRun
                key={activeUserId}
                userId={activeUserId}
                bankrollSet={bankroll.known || settings.startingBankroll !== null || moves.moves.length > 0}
                oddsFormat={settings.oddsFormat}
                oddsSettled={settings.updatedAt !== '' || shownBets.length > 0}
                hasBets={shownBets.length > 0}
                onSetBankroll={openBankroll}
                onPickOdds={(oddsFormat) => updateSettings({ oddsFormat })}
                onAddBet={openQuick}
              />
            )}

            <RangeBar range={range} onChange={changeRange} />

            <KeyStats
              lifetime={scoped}
              rangeName={rangeName}
              hasBets={shownBets.length > 0}
              bankroll={bankroll}
              offline={isOffline}
              open={openList}
              onOpenBankroll={openBankroll}
              onOpenPending={() => setPendingOpen(true)}
            />

            <HeroStats
              bets={shownBets}
              lifetime={scoped}
              rangeName={rangeName}
              ym={ym}
              onPrev={() => setYm((m) => addMonths(m, -1))}
              onNext={() => setYm((m) => addMonths(m, 1))}
              onResetMonth={() => setYm(currentMonth())}
            />

            <div className="grid-mid">
              <CalendarView ym={ym} dayMap={dayMap} onDayClick={openDay} />
              <BalanceChart
                bets={shownBets}
                lifetime={scoped}
                rangeName={rangeName}
                range={range}
                ym={ym}
                bankroll={bankroll}
                moves={moves.moves}
                onSetUpBankroll={openBankroll}
              />
            </div>

            <AdvancedSection rangeName={rangeName}>
              <AdvancedStats lifetime={scoped} />
              <Breakdown bets={ranged} oddsFormat={settings.oddsFormat} />
            </AdvancedSection>

            <HistoryTable
              bets={shownBets}
              oddsFormat={settings.oddsFormat}
              range={historyRange}
              onEdit={(b) => setDay({ date: b.date, edit: { id: b.id } })}
              onOpenDay={openDay}
              onDelete={handleDelete}
              onSettle={handleSettle}
              onBulkRetag={handleBulkRetag}
              onBulkSettle={handleBulkSettle}
              onBulkDelete={handleBulkDelete}
            />
          </div>
        ) : (
          <MoneyContext.Provider value={expenseMoney}>
            {/* The fallback never carries .expenses-view or .exp-bar: tests and the harness wait for the real view. */}
            <Suspense
              fallback={
                <div className="view-panel expenses-loading" role="tabpanel" id="view-panel-expenses" aria-labelledby="view-tab-expenses" aria-busy="true">
                  <p className="empty-state">{t('exp.loading')}</p>
                </div>
              }
            >
              <ExpensesView
                ym={ym}
                onPrevMonth={() => setYm((m) => addMonths(m, -1))}
                onNextMonth={() => setYm((m) => addMonths(m, 1))}
                onThisMonth={() => setYm(currentMonth())}
                expenses={expenses.rows}
                cards={cards.rows}
                budgets={budgets.rows}
                expensesLoaded={expenses.loaded}
                cardsLoaded={cards.loaded}
                budgetsLoaded={budgets.loaded}
                settingsLoaded={settingsLoaded}
                offline={isOffline || sessionEnded}
                needs008={needs008}
                needs009={needs009}
                currency={settings.expenseCurrency}
                onAdd={openExpense}
                onEdit={(e) => setExpenseSheet({ kind: 'edit', id: e.id })}
                onDelete={(e) => void handleDeleteExpense(e)}
                onManage={setExpenseSettings}
                onExport={handleExportExpenses}
              />
            </Suspense>
          </MoneyContext.Provider>
        )}

        {day !== null && (
          <DayModal
            // A new day, or another bet to open on: a fresh form.
            key={`${day.date}|${day.edit?.id ?? ''}|${day.edit?.as ?? ''}`}
            date={day.date}
            bets={modalBets}
            edit={day.edit}
            oddsFormat={settings.oddsFormat}
            suggestions={suggestions}
            bankroll={bankroll.known ? bankroll.current : null}
            drafts={dayDrafts}
            onAdd={handleAdd}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
            onClose={(kept) => {
              setDay(null)
              if (kept) setToast({ kind: 'ok', text: t('draft.kept') })
            }}
          />
        )}

        {quickOpen && (
          <QuickAdd
            bets={shownBets}
            settings={settings}
            suggestions={suggestions}
            bankroll={bankroll.known ? bankroll.current : null}
            onAdd={handleAdd}
            draft={quickStart}
            onDraft={(draft) => {
              quickDraft.current = draft
              if (activeUserId) saveQuickDraft(activeUserId, draft)
            }}
            onMore={(draft) => {
              // The full form for the day chosen, with what was typed.
              const today = draft.date
              if (activeUserId) {
                saveDayDraft(activeUserId, dayDraftId(today, null), {
                  savedAt: new Date().toISOString(),
                  date: today,
                  editingId: null,
                  status: 'won',
                  amount: draft.profit,
                  stake: draft.stake,
                  odds: draft.odds,
                  closing: '',
                  note: '',
                  sport: draft.sport,
                  book: draft.book,
                  betType: draft.betType
                })
                saveQuickDraft(activeUserId, null)
              }
              quickDraft.current = null
              setQuickOpen(false)
              openDay(today)
            }}
            onClose={() => {
              setQuickOpen(false)
              if (quickDraft.current) setToast({ kind: 'ok', text: t('draft.kept') })
            }}
          />
        )}

        {settingsOpen && (
          <SettingsDialog
            settings={settings}
            dirty={settingsDirty}
            blocked={settingsBlocked}
            saveState={settingsSaveState}
            offline={isOffline || sessionEnded}
            bankroll={bankroll}
            onChange={(patch) => void updateSettings(patch)}
            onOpenBankroll={openBankroll}
            onClose={() => setSettingsOpen(false)}
          />
        )}

        {bankrollOpen && (
          <BankrollDialog
            bankroll={bankroll}
            moves={moves.moves}
            startingBankroll={settings.startingBankroll}
            movesLoaded={moves.loaded}
            firstBetDate={firstBet}
            offline={isOffline}
            syncNote={bankrollSyncNote}
            onSetStart={(value) => updateSettings({ startingBankroll: value })}
            onAdd={handleAddMove}
            onUpdate={handleUpdateMove}
            onDelete={handleDeleteMove}
            onClose={() => setBankrollOpen(false)}
          />
        )}

        {dataOpen && activeUserId && (
          <DataDialog
            bets={shownBets}
            moves={moves.moves}
            settings={settings}
            account={{ id: activeUserId, email: activeEmail }}
            oddsFormat={settings.oddsFormat}
            restoreReady={moves.loaded && settingsLoaded}
            backupReady={moves.loaded && settingsLoaded && expenses.loaded && cards.loaded && budgets.loaded}
            currencyWritable={has008}
            batches={batches}
            importing={sync.importing}
            live={batchLive}
            offline={isOffline || sessionEnded}
            onExportCsv={handleExport}
            onDownloadBackup={handleBackup}
            onImport={handleImport}
            onRestore={handleRestore}
            onUndoBatch={(b) => undoBatch(b)}
            onRecover={recoverBatch}
            onClose={() => setDataOpen(false)}
          />
        )}

        {pendingOpen && (
          <PendingPanel
            open={openList}
            oddsFormat={settings.oddsFormat}
            onSettle={(bet, next, amount) => {
              // A result that can't be worked out (a win's profit, a loss without a stake) opens the bet to type it; get out of its way.
              if ((next === 'won' && (amount === null || amount === 0)) || (next === 'lost' && amount === null)) setPendingOpen(false)
              handleSettle(bet, next, amount)
            }}
            onEdit={(bet) => {
              setPendingOpen(false)
              setDay({ date: bet.date, edit: { id: bet.id } })
            }}
            onClose={() => setPendingOpen(false)}
          />
        )}

        {expenseSheet && !editGone && (
          <MoneyContext.Provider value={expenseMoney}>
            <Suspense fallback={null}>
              <ExpenseSheet
                // A new sheet for each thing it opens on: fresh boxes, fresh stage.
                key={expenseSheet.kind === 'edit' ? `edit|${expenseSheet.id}` : 'add'}
                editing={editingExpense}
                draft={expenseSheet.kind === 'add' ? (expenseSheet.draft ?? null) : null}
                preferCardId={expenseSheet.kind === 'add' ? (expenseSheet.preferCardId ?? null) : null}
                cards={cards.rows}
                cardsLoaded={cards.loaded}
                existing={expenses.rows}
                last={activeUserId ? loadExpenseLast(activeUserId) : null}
                currency={settings.expenseCurrency}
                demo={import.meta.env.MODE === 'demo'}
                scanBlocked={scanBlocked}
                extract={runExtract}
                onAdd={handleAddExpense}
                onUpdate={handleUpdateExpense}
                onDelete={handleDeleteExpense}
                onAddMany={handleAddExpenses}
                onManageCards={(draft) => {
                  resumeRef.current = { draft, addedCardId: null }
                  setExpenseSheet(null)
                  setExpenseSettings('cards')
                }}
                onClose={() => setExpenseSheet(null)}
              />
            </Suspense>
          </MoneyContext.Provider>
        )}

        {expenseSettings && (
          <MoneyContext.Provider value={expenseMoney}>
            <Suspense fallback={null}>
              <ExpenseSettings
                section={expenseSettings}
                cards={cards.rows}
                budgets={budgets.rows}
                expenses={expenses.rows}
                month={monthSpend(expenses.rows, ym, cards.rows)}
                ym={ym}
                cardsLoaded={cards.loaded}
                budgetsLoaded={budgets.loaded}
                settingsLoaded={settingsLoaded}
                expensesSure={expenses.loaded && expenses.tableReady}
                currency={settings.expenseCurrency}
                has008={has008}
                needs008={needs008}
                onSaveCard={handleSaveCard}
                onDeleteCard={handleDeleteCard}
                onRestoreCard={handleRestoreCard}
                onSetBudget={handleSetBudget}
                onSetCurrency={handleSetCurrency}
                onClose={closeExpenseSettings}
              />
            </Suspense>
          </MoneyContext.Provider>
        )}

        {/* The live region is always there, so each message put into it is
            announced (one inserted along with its text often isn't). */}
        <div className="toast-region" role="status">
          {toast && <Toast key={toast.seq} msg={toast.msg} onDone={clearToast} />}
        </div>
      </div>
    </MoneyContext.Provider>
  )
}
