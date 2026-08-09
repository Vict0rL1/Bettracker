import { useCallback, useEffect, useMemo, useState } from 'react'
import type { EntryInput } from '../../shared/types'
import BalanceChart from './components/BalanceChart'
import Breakdown from './components/Breakdown'
import CalendarView from './components/CalendarView'
import DayModal, { type TagSuggestions } from './components/DayModal'
import Header from './components/Header'
import HeroStats from './components/HeroStats'
import HistoryTable from './components/HistoryTable'
import Toast, { type ToastMsg } from './components/Toast'
import Login from './auth/Login'
import { useAuth } from './auth/AuthProvider'
import { useEntrySync } from './data/useEntrySync'
import { downloadCsv, parseEntriesCsv } from './lib/csv'
import { summarize, tagValues, type DaySummary } from './lib/stats'
import { useTheme } from './lib/theme'
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
  const { theme, toggle: toggleTheme } = useTheme()

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

  // One grouping pass feeds the calendar, the stat cards and the chart.
  const lifetime = useMemo(() => summarize(entries ?? []), [entries])

  const dayMap = useMemo(() => {
    const map = new Map<string, DaySummary>()
    for (const day of lifetime.days) map.set(day.date, day)
    return map
  }, [lifetime])

  const suggestions = useMemo<TagSuggestions>(
    () => ({
      sport: tagValues(entries ?? [], 'sport'),
      book: tagValues(entries ?? [], 'book'),
      betType: tagValues(entries ?? [], 'betType')
    }),
    [entries]
  )

  const modalSessions = modalDate ? (dayMap.get(modalDate)?.entries ?? []) : []

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modalDate !== null) return
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (e.key === 'ArrowLeft') setYm((m) => addMonths(m, -1))
      if (e.key === 'ArrowRight') setYm((m) => addMonths(m, 1))
      if (e.key === 't' || e.key === 'T') setModalDate(todayStr())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modalDate])

  const savedNote = useCallback(
    (action: string, date?: string) =>
      isOffline
        ? `${action} — saved on this device, will sync when you’re back online`
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

  const handleImport = useCallback(
    async (file: File) => {
      try {
        const { rows, errors, skipped } = parseEntriesCsv(await file.text())
        if (rows.length === 0) {
          setToast({ kind: 'error', text: errors[0] ?? 'Nothing to import from that file.' })
          return
        }
        const count = sync.importSessions(rows)
        const tail = skipped > 0 ? ` · skipped ${skipped} ${skipped === 1 ? 'line' : 'lines'}` : ''
        setToast({
          kind: 'ok',
          text: savedNote(`Imported ${count} ${count === 1 ? 'bet' : 'bets'}${tail}`)
        })
      } catch (err) {
        showError(err)
      }
    },
    [sync, savedNote, showError]
  )

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
        theme={theme}
        onExport={handleExport}
        onImport={handleImport}
        onToggleTheme={toggleTheme}
        onLogToday={() => setModalDate(todayStr())}
        onSignOut={signOut}
      />

      <HeroStats
        entries={shownEntries}
        lifetime={lifetime}
        ym={ym}
        onPrev={() => setYm((m) => addMonths(m, -1))}
        onNext={() => setYm((m) => addMonths(m, 1))}
        onResetMonth={() => setYm(currentMonth())}
      />

      <div className="grid-mid">
        <CalendarView ym={ym} dayMap={dayMap} onDayClick={setModalDate} />
        <BalanceChart entries={shownEntries} lifetime={lifetime} ym={ym} />
      </div>

      <Breakdown entries={shownEntries} />

      <HistoryTable entries={shownEntries} onEdit={setModalDate} onDelete={handleDelete} />

      {modalDate !== null && (
        <DayModal
          date={modalDate}
          sessions={modalSessions}
          suggestions={suggestions}
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
