import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BankrollMove, Bet, BetInput, BetStatus, MoveInput } from '../../shared/types'
import BalanceChart from './components/BalanceChart'
import BankrollDialog from './components/BankrollDialog'
import Breakdown from './components/Breakdown'
import CalendarView from './components/CalendarView'
import DataDialog, { type ImportChoice, type RestoreChoice } from './components/DataDialog'
import FirstRun from './components/FirstRun'
import DayModal, { type DayDrafts, type TagSuggestions } from './components/DayModal'
import Header from './components/Header'
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
import { combinedStatus } from './data/drain'
import { classifySyncError } from './data/errors'
import { StorageWriteError } from './data/store'
import { hasStoredSession } from './lib/supabase'
import { useBetSync } from './data/useBetSync'
import { useMoves } from './data/useMoves'
import { dayDraftId, loadDayDraft, loadQuickDraft, saveDayDraft, saveQuickDraft, type QuickDraft } from './data/drafts'
import { loadImports, markUndone, recordImport, type ImportBatch } from './data/imports'
import { downloadBackup, makeBackup } from './lib/backup'
import { useSettings } from './data/useSettings'
import { bankrollNow, firstBetDate } from './lib/bankroll'
import { retagPlan, settlePlan, toInput, type TagPatch } from './lib/bulk'
import { downloadCsv } from './lib/csv'
import { moneyFormat } from './lib/format'
import { useLang } from './lib/i18n'
import { dismissKey, loadLossDismissed, lossState, saveLossDismissed } from './lib/lossLimit'
import { MoneyContext } from './lib/money'
import { openBets } from './lib/pending'
import { filterRange, loadRange, rangeBounds, saveRange, type DateRange } from './lib/range'
import { forMonth, groupByDay, summarize, tagValues, total, type DaySummary } from './lib/stats'
import { useTheme } from './lib/theme'
import { addMonths, currentMonth, humanDate, todayStr, type MonthKey } from './lib/dates'
import { effectiveUnit } from './lib/validate'
import { PlusIcon } from './components/icons'

const kindOf = (amount: number): 'deposit' | 'withdrawal' => (amount > 0 ? 'deposit' : 'withdrawal')

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
  // The imports made on this device (see data/imports.ts), as last read.
  const [batches, setBatches] = useState<ImportBatch[]>([])
  const [toast, setToast] = useState<ToastMsg | null>(null)

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

  const sync = useBetSync(activeUserId, Boolean(session), showError, showNotice)
  const { bets, status, queuedCount, isOffline } = sync
  const {
    settings,
    dirty: settingsDirty,
    blocked: settingsBlocked,
    loaded: settingsLoaded,
    unsaved: settingsUnsaved,
    status: settingsStatus,
    update: updateSettings,
    saveAgain: saveSettingsAgain
  } = useSettings(activeUserId, Boolean(session), showError, showNotice)
  const moves = useMoves(activeUserId, Boolean(session), showError, showNotice)
  // One badge for the three queues. A settings change or a deposit is a
  // queued change too: the badge says what holds it back (or that it is on
  // its way) even when no bet is queued. An empty queue has no say.
  const badgeStatus = combinedStatus([status, moves.queuedCount > 0 ? moves.status : 'synced', settingsDirty ? settingsStatus : 'synced'])
  const badgeQueued = queuedCount + moves.queuedCount

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
    (moves.refusedUnsaved ? moves.refused.length : 0)
  const refusedList = [...sync.refused, ...moves.refused]

  // Amounts show in units when the user has a unit size and asked for them.
  const unit = effectiveUnit(settings)
  const money = useMemo(() => moneyFormat(unit), [unit])

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (day !== null || quickOpen || settingsOpen || pendingOpen || bankrollOpen || dataOpen) return
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (e.key === 'ArrowLeft') setYm((m) => addMonths(m, -1))
      if (e.key === 'ArrowRight') setYm((m) => addMonths(m, 1))
      if (e.key === 't' || e.key === 'T') {
        // The sheet focuses and selects the stake box as it opens; without this
        // the same keystroke's character would land there and wipe the default.
        e.preventDefault()
        openQuick()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [day, quickOpen, settingsOpen, pendingOpen, bankrollOpen, dataOpen, openQuick])

  // With the session ended the queue waits for a sign-in, not the connection.
  const savedNote = useCallback(
    (action: string, date?: string) =>
      sessionEnded ? t('toast.signedOut', { action }) : isOffline ? t('toast.offline', { action }) : date ? t('toast.onDate', { action, date: humanDate(date) }) : action,
    [sessionEnded, isOffline, t]
  )

  // Mutations apply instantly (optimistic) and sync in the background. The
  // toast says it is done only once storage holds the change: one that is
  // only in this window says so instead (see SyncNotices).
  const done = useCallback(
    (saved: boolean, text: string, undo?: () => Promise<boolean>) => {
      if (!saved) {
        setToast({ kind: 'error', text: t('toast.notSaved') })
        return
      }
      if (!undo) {
        setToast({ kind: 'ok', text })
        return
      }
      // An offer to put things back. The undo goes through the outbox too, so it works offline.
      setToast({
        kind: 'ok',
        text,
        action: {
          label: t('toast.undo'),
          onClick: () => {
            undo().then(
              (kept) => setToast(kept ? { kind: 'ok', text: savedNote(t('toast.undone')) } : { kind: 'error', text: t('toast.notSaved') }),
              showError
            )
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
      if (next === 'won' && (amount === null || amount === 0)) {
        setDay({ date: bet.date, edit: { id: bet.id, as: 'won' } })
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

  // What the Bankroll dialog's changes wait for, judged per queue: a
  // migration for the queue it holds back, the connection for the rest. A
  // change simply on its way says nothing.
  const firstBet = useMemo(() => firstBetDate(bets ?? []), [bets])
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

  const handleBackup = useCallback(() => {
    if (!activeUserId || !bets) return
    const backup = makeBackup(bets, moves.moves, settings, { id: activeUserId, email: activeEmail })
    downloadBackup(backup)
    setToast({ kind: 'ok', text: t('backup.downloaded', { bets: tn('bet', backup.bets.length), moves: tn('move', backup.moves.length) }) })
  }, [activeUserId, activeEmail, bets, moves.moves, settings, t, tn])

  // The latest copy, for an Undo clicked long after the change it undoes.
  const betsRef = useRef(bets)
  betsRef.current = bets
  const movesRef = useRef(moves.moves)
  movesRef.current = moves.moves
  const refreshBatches = useCallback(() => setBatches(activeUserId ? loadImports(activeUserId) : []), [activeUserId])

  /**
   * Undo a whole import (or restore): delete the bets it added that are
   * still here, and the deposits and withdrawals a restore added. Itself
   * undoable: the toast puts them back, with their ids.
   */
  const undoBatch = useCallback(
    async (batch: ImportBatch): Promise<boolean> => {
      const ids = new Set(batch.ids)
      const moveIds = new Set(batch.moveIds ?? [])
      const gone = (betsRef.current ?? []).filter((b) => ids.has(b.id))
      const goneMoves = movesRef.current.filter((m) => moveIds.has(m.id))
      if (activeUserId) markUndone(activeUserId, batch.id)
      refreshBatches()
      if (gone.length === 0 && goneMoves.length === 0) {
        setToast({ kind: 'ok', text: t('imp.undoNothing') })
        return true
      }
      let saved = gone.length > 0 ? await sync.deleteBets(gone.map((b) => b.id)) : true
      for (const m of goneMoves) saved = (await moves.deleteMove(m.id)) && saved
      done(saved, savedNote(t('imp.undone', { bets: tn('bet', gone.length) })), async () => {
        let back = gone.length > 0 ? await sync.restoreBets(gone) : true
        for (const m of goneMoves) back = (await moves.restoreMove(m)) && back
        if (activeUserId) markUndone(activeUserId, batch.id, false)
        refreshBatches()
        return back
      })
      return saved
    },
    [activeUserId, refreshBatches, sync, moves, done, savedNote, t, tn]
  )

  // From the review step: what the user chose to import. Throws when refused.
  const handleImport = useCallback(
    async (choice: ImportChoice): Promise<void> => {
      const { count, saved, opId, ids } = await sync.importBets(choice.rows)
      const batch: ImportBatch = { id: opId, at: new Date().toISOString(), file: choice.file, fingerprint: choice.fingerprint, ids }
      if (activeUserId && count > 0) recordImport(activeUserId, batch)
      refreshBatches()
      const notes =
        (choice.skipped > 0 ? t('imp.doneSkipped', { n: choice.skipped }) : '') + (choice.rejected > 0 ? t('imp.doneRejected', { n: choice.rejected }) : '')
      done(saved, savedNote(t('imp.done', { bets: tn('bet', count) }) + notes), () => undoBatch(batch))
    },
    [activeUserId, sync, refreshBatches, done, savedNote, undoBatch, t, tn]
  )

  // A backup, as planned in the review step: it only adds (see planRestore).
  const handleRestore = useCallback(
    async (choice: RestoreChoice): Promise<void> => {
      const { plan } = choice
      const add = [...plan.newBets, ...(choice.keepDuplicates ? plan.duplicateBets : [])]
      const result = await sync.importBets(
        add.map(toInput),
        add.map((b) => b.id)
      )
      let saved = result.saved
      for (const m of plan.newMoves) saved = (await moves.restoreMove(m)) && saved
      if (choice.replaceSettings && plan.settingsDiffer) updateSettings(plan.settings)
      const batch: ImportBatch = {
        id: result.opId,
        at: new Date().toISOString(),
        file: choice.file,
        fingerprint: choice.fingerprint,
        ids: result.ids,
        moveIds: plan.newMoves.map((m) => m.id),
        kind: 'restore'
      }
      if (activeUserId && (add.length > 0 || plan.newMoves.length > 0)) recordImport(activeUserId, batch)
      refreshBatches()
      done(saved, savedNote(t('backup.restored', { bets: tn('bet', add.length), moves: tn('move', plan.newMoves.length) })), () => undoBatch(batch))
    },
    [activeUserId, sync, moves, updateSettings, refreshBatches, done, savedNote, undoBatch, t, tn]
  )

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

  return (
    <MoneyContext.Provider value={money}>
      <div className="app">
        <Header
          email={activeEmail}
          status={sessionEnded ? 'signedout' : badgeStatus}
          queuedCount={badgeQueued}
          pendingCount={openList.length}
          unsynced={badgeQueued + (settingsDirty ? 1 : 0) + refusedList.length}
          theme={theme}
          onOpenData={() => {
            refreshBatches()
            setDataOpen(true)
          }}
          onToggleTheme={toggleTheme}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenPending={() => setPendingOpen(true)}
          onAddBet={openQuick}
          onSignOut={signOut}
        />

        <SyncNotices
          signedOut={sessionEnded ? badgeQueued + (settingsDirty ? 1 : 0) : null}
          unsaved={unsavedCount}
          refused={refusedList.length > 0 ? { count: refusedList.length, reason: refusedList[0].reason } : null}
          onSignIn={() => setReauth(true)}
          onSaveAgain={() => {
            void Promise.all([sync.saveAgain(), moves.saveAgain(), saveSettingsAgain()]).then((all) => {
              if (!all.every(Boolean)) setToast({ kind: 'error', text: t('toast.notSaved') })
            })
          }}
          onRetryRefused={() => {
            void sync.retryRefused()
            void moves.retryRefused()
          }}
          onDiscardRefused={() => {
            void sync.discardRefused()
            void moves.discardRefused()
          }}
        />

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
              // The full form for today, with what was typed.
              const today = todayStr()
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
            bankroll={bankroll}
            onChange={updateSettings}
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
            complete={moves.loaded && settingsLoaded}
            batches={batches}
            importing={sync.importing}
            onExportCsv={handleExport}
            onDownloadBackup={handleBackup}
            onImport={handleImport}
            onRestore={handleRestore}
            onUndoBatch={(b) => void undoBatch(b)}
            onClose={() => setDataOpen(false)}
          />
        )}

        {pendingOpen && (
          <PendingPanel
            open={openList}
            oddsFormat={settings.oddsFormat}
            onSettle={(bet, next, amount) => {
              // A win whose profit can't be worked out opens the bet to type it; get out of its way.
              if (next === 'won' && (amount === null || amount === 0)) setPendingOpen(false)
              handleSettle(bet, next, amount)
            }}
            onEdit={(bet) => {
              setPendingOpen(false)
              setDay({ date: bet.date, edit: { id: bet.id } })
            }}
            onClose={() => setPendingOpen(false)}
          />
        )}

        {/* Out of the way while a dialog is open: it sits above them, and would open another on top. */}
        {day === null && !quickOpen && !settingsOpen && !pendingOpen && !bankrollOpen && !dataOpen && (
          <button type="button" className="fab" aria-label={t('header.addBet')} title={t('header.addBetTitle')} onClick={openQuick}>
            <PlusIcon size={22} />
          </button>
        )}

        {toast && <Toast msg={toast} onDone={() => setToast(null)} />}
      </div>
    </MoneyContext.Provider>
  )
}
