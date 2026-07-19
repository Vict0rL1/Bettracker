import { useCallback, useEffect, useMemo, useState } from 'react'
import type { EntryInput } from '../../shared/types'
import BalanceChart from './components/BalanceChart'
import CalendarView from './components/CalendarView'
import DayModal from './components/DayModal'
import Header from './components/Header'
import HeroStats from './components/HeroStats'
import HistoryTable from './components/HistoryTable'
import Toast, { type ToastMsg } from './components/Toast'
import Login from './auth/Login'
import { useAuth } from './auth/AuthProvider'
import { useEntrySync } from './data/useEntrySync'
import { downloadCsv } from './lib/csv'
import { groupByDay } from './lib/stats'
import { addMonths, currentMonth, humanDate, todayStr, type MonthKey } from './lib/dates'

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

  // With a live session we sync; with only a cached identity (e.g. reopened
  // fully offline) the app still renders this device's copy of the data.
  const activeUserId = userId ?? offlineUser?.id ?? null
  const activeEmail = email ?? offlineUser?.email ?? null

  const [ym, setYm] = useState<MonthKey>(currentMonth)
  const [modalDate, setModalDate] = useState<string | null>(null)
  const [toast, setToast] = useState<ToastMsg | null>(null)

  const showError = useCallback((err: unknown) => {
    const text = err instanceof Error ? err.message : 'Something went wrong'
    setToast({ kind: 'error', text })
  }, [])

  const sync = useEntrySync(activeUserId, Boolean(session), showError)
  const { entries, status, pendingCount, isOffline } = sync

  useEffect(() => {
    if (!loading && (!activeUserId || entries !== null)) {
      document.documentElement.dataset.ready = '1'
    }
  }, [loading, activeUserId, entries])

  // Sessions grouped into one summary per day, for the calendar and day editor.
  const dayMap = useMemo(() => {
    const map = new Map<string, ReturnType<typeof groupByDay>[number]>()
    for (const day of groupByDay(entries ?? [])) map.set(day.date, day)
    return map
  }, [entries])

  const modalSessions = modalDate ? (dayMap.get(modalDate)?.entries ?? []) : []

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modalDate !== null) return
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (e.key === 'ArrowLeft') setYm((m) => addMonths(m, -1))
      if (e.key === 'ArrowRight') setYm((m) => addMonths(m, 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modalDate])

  const savedNote = useCallback(
    (action: string, date?: string) =>
      isOffline
        ? `${action} — saved on this device, will sync when you're back online`
        : date
          ? `${action} on ${humanDate(date)}`
          : action,
    [isOffline]
  )

  // Mutations apply instantly (optimistic) and sync in the background.
  const handleAdd = useCallback(
    async (input: EntryInput) => {
      try {
        sync.addSession(input)
        setToast({ kind: 'ok', text: savedNote('Added a bet', input.date) })
      } catch (err) {
        showError(err)
      }
    },
    [sync, savedNote, showError]
  )

  const handleUpdate = useCallback(
    async (id: string, input: EntryInput) => {
      try {
        sync.updateSession(id, input)
        setToast({ kind: 'ok', text: savedNote('Updated a bet', input.date) })
      } catch (err) {
        showError(err)
      }
    },
    [sync, savedNote, showError]
  )

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        sync.deleteSession(id)
        setToast({ kind: 'ok', text: savedNote('Deleted a bet') })
      } catch (err) {
        showError(err)
      }
    },
    [sync, savedNote, showError]
  )

  const handleExport = useCallback(() => {
    if (!entries || entries.length === 0) return
    const count = downloadCsv(entries)
    setToast({ kind: 'ok', text: `Exported ${count} ${count === 1 ? 'bet' : 'bets'} to your downloads` })
  }, [entries])

  if (loading) return <Boot />
  if (!activeUserId) return <Login />

  // No cached data yet: wait for the first fetch unless we're offline, in
  // which case show the (empty) app instead of blocking forever.
  const shownEntries = entries ?? (isOffline ? [] : null)
  if (shownEntries === null) return <Boot />

  return (
    <div className="app">
      <Header
        email={activeEmail}
        status={status}
        pendingCount={pendingCount}
        canExport={shownEntries.length > 0}
        onExport={handleExport}
        onLogToday={() => setModalDate(todayStr())}
        onSignOut={signOut}
      />

      <HeroStats
        entries={shownEntries}
        ym={ym}
        onPrev={() => setYm((m) => addMonths(m, -1))}
        onNext={() => setYm((m) => addMonths(m, 1))}
        onResetMonth={() => setYm(currentMonth())}
      />

      <div className="grid-mid">
        <CalendarView ym={ym} dayMap={dayMap} onDayClick={setModalDate} />
        <BalanceChart entries={shownEntries} />
      </div>

      <HistoryTable entries={shownEntries} onEdit={setModalDate} onDelete={handleDelete} />

      {modalDate !== null && (
        <DayModal
          date={modalDate}
          sessions={modalSessions}
          onAdd={handleAdd}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
          onClose={() => setModalDate(null)}
        />
      )}

      {toast && <Toast msg={toast} onDone={() => setToast(null)} />}
    </div>
  )
}
