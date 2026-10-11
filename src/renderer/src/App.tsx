import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BankrollMove, Bet, BetInput, BetStatus, MoveInput } from '../../shared/types'
import BalanceChart from './components/BalanceChart'
import BankrollDialog from './components/BankrollDialog'
import Breakdown from './components/Breakdown'
import CalendarView from './components/CalendarView'
import DayModal, { type TagSuggestions } from './components/DayModal'
import Header from './components/Header'
import HeroStats from './components/HeroStats'
import HistoryTable from './components/HistoryTable'
import LossBanner from './components/LossBanner'
import PendingPanel from './components/PendingPanel'
import QuickAdd from './components/QuickAdd'
import RangeBar from './components/RangeBar'
import SettingsDialog from './components/SettingsDialog'
import Toast, { type ToastMsg } from './components/Toast'
import Login from './auth/Login'
import { useAuth } from './auth/AuthProvider'
import { combinedStatus } from './data/drain'
import { useBetSync } from './data/useBetSync'
import { useMoves } from './data/useMoves'
import { useSettings } from './data/useSettings'
import { bankrollNow } from './lib/bankroll'
import { retagPlan, settlePlan, type TagPatch } from './lib/bulk'
import { downloadCsv, parseBetsCsv } from './lib/csv'
import { moneyFormat } from './lib/format'
import { useLang } from './lib/i18n'
import { dismissKey, loadLossDismissed, lossState, saveLossDismissed } from './lib/lossLimit'
import { MoneyContext } from './lib/money'
import { openBets } from './lib/pending'
import { filterRange, loadRange, saveRange, type DateRange } from './lib/range'
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
  const { loading, session, userId, email, offlineUser, signOut } = useAuth()
  const { theme, toggle: toggleTheme } = useTheme()
  const { t, tn } = useLang()

  // With a live session we sync; with only a cached identity (e.g. reopened
  // fully offline) the app still renders this device's copy of the data.
  const activeUserId = userId ?? offlineUser?.id ?? null
  const activeEmail = email ?? offlineUser?.email ?? null

  const [ym, setYm] = useState<MonthKey>(currentMonth)
  const [modalDate, setModalDate] = useState<string | null>(null)
  const [quickOpen, setQuickOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pendingOpen, setPendingOpen] = useState(false)
  const [bankrollOpen, setBankrollOpen] = useState(false)
  const [toast, setToast] = useState<ToastMsg | null>(null)

  const showError = useCallback(
    (err: unknown) => {
      const text = err instanceof Error ? err.message : t('common.error')
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
    update: updateSettings
  } = useSettings(activeUserId, Boolean(session), showError, showNotice)
  const moves = useMoves(activeUserId, Boolean(session), showError, showNotice)
  // One badge for the three queues. A settings change or a deposit waiting on
  // a migration is a queued change too: the badge says so even when no bet is
  // queued. An empty queue has no say.
  const badgeStatus = combinedStatus([
    status,
    moves.queuedCount > 0 ? moves.status : 'synced',
    settingsDirty && settingsBlocked ? 'behind' : 'synced'
  ])
  const badgeQueued = queuedCount + moves.queuedCount

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

  // The stat cards, the chart and the breakdown follow the chosen date range;
  // the calendar, the month card, the history and the pending count always
  // see everything.
  const [range, setRange] = useState<DateRange>(loadRange)
  const changeRange = useCallback((next: DateRange) => {
    setRange(next)
    saveRange(next)
  }, [])
  const ranged = useMemo(() => filterRange(bets ?? [], range, todayStr()), [bets, range])
  const scoped = useMemo(() => summarize(ranged), [ranged])
  const rangeName = range.kind === 'all' ? null : t(`range.${range.kind}`)

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

  const modalBets = modalDate ? (dayMap.get(modalDate)?.bets ?? []) : []
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
      if (modalDate !== null || quickOpen || settingsOpen || pendingOpen || bankrollOpen) return
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (e.key === 'ArrowLeft') setYm((m) => addMonths(m, -1))
      if (e.key === 'ArrowRight') setYm((m) => addMonths(m, 1))
      if (e.key === 't' || e.key === 'T') {
        // The sheet focuses and selects the stake box as it opens; without this
        // the same keystroke's character would land there and wipe the default.
        e.preventDefault()
        setQuickOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modalDate, quickOpen, settingsOpen, pendingOpen, bankrollOpen])

  const savedNote = useCallback(
    (action: string, date?: string) => (isOffline ? t('toast.offline', { action }) : date ? t('toast.onDate', { action, date: humanDate(date) }) : action),
    [isOffline, t]
  )

  // Mutations apply instantly (optimistic) and sync in the background.
  const handleAdd = useCallback(
    async (input: BetInput) => {
      try {
        sync.addBet(input)
        setToast({ kind: 'ok', text: savedNote(t(input.status === 'pending' ? 'toast.loggedPending' : 'toast.added'), input.date) })
      } catch (err) {
        showError(err)
      }
    },
    [sync, savedNote, showError, t]
  )

  const handleUpdate = useCallback(
    async (id: string, input: BetInput) => {
      try {
        sync.updateBet(id, input)
        setToast({ kind: 'ok', text: savedNote(t('toast.updated'), input.date) })
      } catch (err) {
        showError(err)
      }
    },
    [sync, savedNote, showError, t]
  )

  /** A toast that offers to put things back. The undo goes through the outbox too, so it works offline. */
  const undoable = useCallback(
    (text: string, undo: () => void) =>
      setToast({
        kind: 'ok',
        text,
        action: {
          label: t('toast.undo'),
          onClick: () => {
            try {
              undo()
              setToast({ kind: 'ok', text: savedNote(t('toast.undone')) })
            } catch (err) {
              showError(err)
            }
          }
        }
      }),
    [savedNote, showError, t]
  )

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        const gone = (bets ?? []).find((b) => b.id === id)
        sync.deleteBet(id)
        if (gone) undoable(savedNote(t('toast.deleted')), () => sync.restoreBets([gone]))
        else setToast({ kind: 'ok', text: savedNote(t('toast.deleted')) })
      } catch (err) {
        showError(err)
      }
    },
    [bets, sync, savedNote, showError, undoable, t]
  )

  const handleBulkDelete = useCallback(
    (ids: string[]) => {
      try {
        const wanted = new Set(ids)
        const gone = (bets ?? []).filter((b) => wanted.has(b.id))
        if (gone.length === 0) return
        sync.deleteBets(gone.map((b) => b.id))
        undoable(savedNote(t('toast.deletedN', { bets: tn('bet', gone.length) })), () => sync.restoreBets(gone))
      } catch (err) {
        showError(err)
      }
    },
    [bets, sync, savedNote, showError, undoable, t, tn]
  )

  const handleBulkRetag = useCallback(
    (ids: string[], patch: TagPatch) => {
      try {
        const wanted = new Set(ids)
        const plan = retagPlan((bets ?? []).filter((b) => wanted.has(b.id)), patch)
        if (plan.next.length === 0) {
          setToast({ kind: 'ok', text: t('toast.retagNothing') })
          return
        }
        sync.updateBets(plan.next)
        undoable(savedNote(t('toast.retagged', { bets: tn('bet', plan.next.length) })), () => sync.updateBets(plan.prev))
      } catch (err) {
        showError(err)
      }
    },
    [bets, sync, savedNote, showError, undoable, t, tn]
  )

  const handleBulkSettle = useCallback(
    (ids: string[], status: Exclude<BetStatus, 'pending'>) => {
      try {
        const wanted = new Set(ids)
        const plan = settlePlan((bets ?? []).filter((b) => wanted.has(b.id)), status)
        const skipped = plan.skipped > 0 ? t('toast.settleSkipped', { n: plan.skipped }) : ''
        if (plan.next.length === 0) {
          setToast({ kind: 'ok', text: t('toast.settleNone') + skipped })
          return
        }
        sync.updateBets(plan.next)
        undoable(savedNote(t('toast.settledN', { bets: tn('bet', plan.next.length), status: t(`statusWord.${status}`) }) + skipped), () => sync.updateBets(plan.prev))
      } catch (err) {
        showError(err)
      }
    },
    [bets, sync, savedNote, showError, undoable, t, tn]
  )

  // Settling from the history table: when the result follows from stake and
  // odds it's one tap; when it doesn't (no odds on a win), open the day so the
  // user can type it.
  const handleSettle = useCallback(
    (bet: Bet, next: BetStatus, amount: number | null) => {
      if (next === 'won' && amount === null) {
        setModalDate(bet.date)
        return
      }
      try {
        sync.updateBet(bet.id, {
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
        setToast({ kind: 'ok', text: savedNote(t('toast.settled', { status: t(`statusWord.${next}`) }), bet.date) })
      } catch (err) {
        showError(err)
      }
    },
    [sync, savedNote, showError, t]
  )

  // Deposits and withdrawals. The toast names the kind (in Spanish an ingreso
  // and a retirada take different endings).
  const handleAddMove = useCallback(
    (input: MoveInput) => {
      try {
        moves.addMove(input)
        setToast({ kind: 'ok', text: savedNote(t(kindOf(input.amount) === 'deposit' ? 'toast.depositAdded' : 'toast.withdrawalAdded'), input.date) })
      } catch (err) {
        showError(err)
      }
    },
    [moves, savedNote, showError, t]
  )

  const handleUpdateMove = useCallback(
    (id: string, input: MoveInput) => {
      try {
        moves.updateMove(id, input)
        setToast({ kind: 'ok', text: savedNote(t(kindOf(input.amount) === 'deposit' ? 'toast.depositUpdated' : 'toast.withdrawalUpdated'), input.date) })
      } catch (err) {
        showError(err)
      }
    },
    [moves, savedNote, showError, t]
  )

  const handleDeleteMove = useCallback(
    (m: BankrollMove) => {
      try {
        moves.deleteMove(m.id)
        undoable(savedNote(t(kindOf(m.amount) === 'deposit' ? 'toast.depositDeleted' : 'toast.withdrawalDeleted')), () => moves.restoreMove(m))
      } catch (err) {
        showError(err)
      }
    },
    [moves, savedNote, showError, undoable, t]
  )

  const openBankroll = useCallback(() => {
    setSettingsOpen(false)
    setBankrollOpen(true)
  }, [])

  const handleExport = useCallback(() => {
    if (!bets || bets.length === 0) return
    const count = downloadCsv(bets)
    setToast({ kind: 'ok', text: t('toast.exported', { bets: tn('bet', count) }) })
  }, [bets, t, tn])

  const handleImport = useCallback(
    async (file: File) => {
      try {
        const { rows, errors, skipped, noStake } = parseBetsCsv(await file.text(), settings.oddsFormat)
        if (rows.length === 0) {
          setToast({ kind: 'error', text: errors[0] ?? t('toast.importNothing') })
          return
        }
        const count = sync.importBets(rows)
        const notes: string[] = []
        if (skipped > 0) notes.push(t('toast.skipped', { lines: tn('line', skipped) }))
        if (noStake > 0) notes.push(t('toast.noStake', { n: noStake }))
        setToast({ kind: 'ok', text: savedNote(t('toast.imported', { bets: tn('bet', count) }) + (notes.length ? ` · ${notes.join(' · ')}` : '')) })
      } catch (err) {
        showError(err)
      }
    },
    [sync, savedNote, showError, t, tn, settings.oddsFormat]
  )

  if (loading) return <Boot />
  if (!activeUserId) return <Login />

  // No cached data yet: wait for the first fetch unless we're offline, in
  // which case show the (empty) app instead of blocking forever.
  const shownBets = bets ?? (isOffline ? [] : null)
  if (shownBets === null) return <Boot />

  return (
    <MoneyContext.Provider value={money}>
      <div className="app">
        <Header
          email={activeEmail}
          status={badgeStatus}
          queuedCount={badgeQueued}
          pendingCount={openList.length}
          unsynced={badgeQueued + (settingsDirty ? 1 : 0)}
          canExport={shownBets.length > 0}
          theme={theme}
          onExport={handleExport}
          onImport={handleImport}
          onToggleTheme={toggleTheme}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenPending={() => setPendingOpen(true)}
          onLogToday={() => setModalDate(todayStr())}
          onSignOut={signOut}
        />

        {loss.level !== 'none' && lossDismissed !== lossKey && <LossBanner state={loss} onChangeLimit={() => setSettingsOpen(true)} onDismiss={dismissLoss} />}

        <RangeBar range={range} onChange={changeRange} />

        <HeroStats
          bets={shownBets}
          lifetime={scoped}
          rangeName={rangeName}
          ym={ym}
          bankroll={bankroll}
          offline={isOffline}
          onPrev={() => setYm((m) => addMonths(m, -1))}
          onNext={() => setYm((m) => addMonths(m, 1))}
          onResetMonth={() => setYm(currentMonth())}
          onOpenBankroll={openBankroll}
        />

        <div className="grid-mid">
          <CalendarView ym={ym} dayMap={dayMap} onDayClick={setModalDate} />
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

        <Breakdown bets={ranged} oddsFormat={settings.oddsFormat} />

        <HistoryTable
          bets={shownBets}
          oddsFormat={settings.oddsFormat}
          onEdit={setModalDate}
          onDelete={handleDelete}
          onSettle={handleSettle}
          onBulkRetag={handleBulkRetag}
          onBulkSettle={handleBulkSettle}
          onBulkDelete={handleBulkDelete}
        />

        {modalDate !== null && (
          <DayModal
            date={modalDate}
            bets={modalBets}
            oddsFormat={settings.oddsFormat}
            suggestions={suggestions}
            bankroll={bankroll.known ? bankroll.current : null}
            onAdd={handleAdd}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
            onClose={() => setModalDate(null)}
          />
        )}

        {quickOpen && (
          <QuickAdd
            bets={shownBets}
            settings={settings}
            suggestions={suggestions}
            bankroll={bankroll.known ? bankroll.current : null}
            onAdd={handleAdd}
            onClose={() => setQuickOpen(false)}
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
            offline={isOffline}
            dirty={moves.queuedCount > 0 || settingsDirty}
            blocked={moves.blocked || settingsBlocked}
            onSetStart={(value) => updateSettings({ startingBankroll: value })}
            onAdd={handleAddMove}
            onUpdate={handleUpdateMove}
            onDelete={handleDeleteMove}
            onClose={() => setBankrollOpen(false)}
          />
        )}

        {pendingOpen && (
          <PendingPanel
            open={openList}
            oddsFormat={settings.oddsFormat}
            onSettle={(bet, next, amount) => {
              // A win with no odds opens the day to type the profit; get out of its way.
              if (next === 'won' && amount === null) setPendingOpen(false)
              handleSettle(bet, next, amount)
            }}
            onOpenDay={(date) => {
              setPendingOpen(false)
              setModalDate(date)
            }}
            onClose={() => setPendingOpen(false)}
          />
        )}

        <button type="button" className="fab" aria-label={t('quick.fab')} title={`${t('quick.fab')} (T)`} onClick={() => setQuickOpen(true)}>
          <PlusIcon size={22} />
        </button>

        {toast && <Toast msg={toast} onDone={() => setToast(null)} />}
      </div>
    </MoneyContext.Provider>
  )
}
