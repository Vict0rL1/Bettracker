import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Bet, BetInput, BetStatus } from '../../shared/types'
import BalanceChart from './components/BalanceChart'
import Breakdown from './components/Breakdown'
import CalendarView from './components/CalendarView'
import DayModal, { type TagSuggestions } from './components/DayModal'
import Header from './components/Header'
import HeroStats from './components/HeroStats'
import HistoryTable from './components/HistoryTable'
import QuickAdd from './components/QuickAdd'
import Toast, { type ToastMsg } from './components/Toast'
import Login from './auth/Login'
import { useAuth } from './auth/AuthProvider'
import { useBetSync } from './data/useBetSync'
import { useSettings } from './data/useSettings'
import { downloadCsv, parseBetsCsv } from './lib/csv'
import { useLang } from './lib/i18n'
import { summarize, tagValues, type DaySummary } from './lib/stats'
import { useTheme } from './lib/theme'
import { addMonths, currentMonth, humanDate, todayStr, type MonthKey } from './lib/dates'
import { PlusIcon } from './components/icons'

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
  const { settings } = useSettings(activeUserId, Boolean(session), showError, showNotice)

  useEffect(() => {
    if (!loading && (!activeUserId || bets !== null)) {
      document.documentElement.dataset.ready = '1'
    }
  }, [loading, activeUserId, bets])

  // One grouping pass feeds the calendar, the stat cards and the chart.
  const lifetime = useMemo(() => summarize(bets ?? []), [bets])

  const dayMap = useMemo(() => {
    const map = new Map<string, DaySummary>()
    for (const day of lifetime.days) map.set(day.date, day)
    return map
  }, [lifetime])

  const suggestions = useMemo<TagSuggestions>(
    () => ({
      sport: tagValues(bets ?? [], 'sport'),
      book: tagValues(bets ?? [], 'book'),
      betType: tagValues(bets ?? [], 'betType')
    }),
    [bets]
  )

  const modalBets = modalDate ? (dayMap.get(modalDate)?.bets ?? []) : []

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modalDate !== null || quickOpen) return
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
  }, [modalDate, quickOpen])

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

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        sync.deleteBet(id)
        setToast({ kind: 'ok', text: savedNote(t('toast.deleted')) })
      } catch (err) {
        showError(err)
      }
    },
    [sync, savedNote, showError, t]
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

  const handleExport = useCallback(() => {
    if (!bets || bets.length === 0) return
    const count = downloadCsv(bets)
    setToast({ kind: 'ok', text: t('toast.exported', { bets: tn('bet', count) }) })
  }, [bets, t, tn])

  const handleImport = useCallback(
    async (file: File) => {
      try {
        const { rows, errors, skipped, noStake } = parseBetsCsv(await file.text())
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
    [sync, savedNote, showError, t, tn]
  )

  if (loading) return <Boot />
  if (!activeUserId) return <Login />

  // No cached data yet: wait for the first fetch unless we're offline, in
  // which case show the (empty) app instead of blocking forever.
  const shownBets = bets ?? (isOffline ? [] : null)
  if (shownBets === null) return <Boot />

  return (
    <div className="app">
      <Header
        email={activeEmail}
        status={status}
        queuedCount={queuedCount}
        canExport={shownBets.length > 0}
        theme={theme}
        onExport={handleExport}
        onImport={handleImport}
        onToggleTheme={toggleTheme}
        onLogToday={() => setModalDate(todayStr())}
        onSignOut={signOut}
      />

      <HeroStats
        bets={shownBets}
        lifetime={lifetime}
        ym={ym}
        onPrev={() => setYm((m) => addMonths(m, -1))}
        onNext={() => setYm((m) => addMonths(m, 1))}
        onResetMonth={() => setYm(currentMonth())}
      />

      <div className="grid-mid">
        <CalendarView ym={ym} dayMap={dayMap} onDayClick={setModalDate} />
        <BalanceChart bets={shownBets} lifetime={lifetime} ym={ym} />
      </div>

      <Breakdown bets={shownBets} />

      <HistoryTable bets={shownBets} onEdit={setModalDate} onDelete={handleDelete} onSettle={handleSettle} />

      {modalDate !== null && (
        <DayModal
          date={modalDate}
          bets={modalBets}
          suggestions={suggestions}
          onAdd={handleAdd}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
          onClose={() => setModalDate(null)}
        />
      )}

      {quickOpen && (
        <QuickAdd bets={shownBets} settings={settings} suggestions={suggestions} onAdd={handleAdd} onClose={() => setQuickOpen(false)} />
      )}

      <button type="button" className="fab" aria-label={t('quick.fab')} title={`${t('quick.fab')} (T)`} onClick={() => setQuickOpen(true)}>
        <PlusIcon size={22} />
      </button>

      {toast && <Toast msg={toast} onDone={() => setToast(null)} />}
    </div>
  )
}
