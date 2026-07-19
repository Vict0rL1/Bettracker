import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BetEntry, EntryInput } from '../../shared/types'
import BalanceChart from './components/BalanceChart'
import CalendarView from './components/CalendarView'
import DayModal from './components/DayModal'
import Header from './components/Header'
import HeroStats from './components/HeroStats'
import HistoryTable from './components/HistoryTable'
import Toast, { type ToastMsg } from './components/Toast'
import Login from './auth/Login'
import { useAuth } from './auth/AuthProvider'
import { addEntry, deleteEntry, getEntries, subscribeToEntries, updateEntry } from './data/entries'
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
  const { loading, session, userId, email, signOut } = useAuth()

  const [entries, setEntries] = useState<BetEntry[] | null>(null)
  const [ym, setYm] = useState<MonthKey>(currentMonth)
  const [modalDate, setModalDate] = useState<string | null>(null)
  const [toast, setToast] = useState<ToastMsg | null>(null)

  const showError = useCallback((err: unknown) => {
    const text = err instanceof Error ? err.message : 'Something went wrong'
    setToast({ kind: 'error', text })
  }, [])

  const reload = useCallback(async () => {
    setEntries(await getEntries())
  }, [])

  useEffect(() => {
    if (!userId) {
      setEntries(null)
      return
    }
    reload().catch(showError)
  }, [userId, reload, showError])

  // Live sync: refetch whenever this account's rows change on any device.
  useEffect(() => {
    if (!userId) return
    const unsubscribe = subscribeToEntries(userId, () => {
      reload().catch(showError)
    })
    return unsubscribe
  }, [userId, reload, showError])

  useEffect(() => {
    if (!loading && (!session || entries !== null)) {
      document.documentElement.dataset.ready = '1'
    }
  }, [loading, session, entries])

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

  // Add / edit / delete a single session. The day modal stays open so you can
  // log several in a row (morning, then afternoon, …).
  const handleAdd = useCallback(
    async (input: EntryInput) => {
      try {
        await addEntry(input)
        await reload()
        setToast({ kind: 'ok', text: `Added a bet on ${humanDate(input.date)}` })
      } catch (err) {
        showError(err)
      }
    },
    [reload, showError]
  )

  const handleUpdate = useCallback(
    async (id: string, input: EntryInput) => {
      try {
        await updateEntry(id, input)
        await reload()
        setToast({ kind: 'ok', text: `Updated a bet on ${humanDate(input.date)}` })
      } catch (err) {
        showError(err)
      }
    },
    [reload, showError]
  )

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await deleteEntry(id)
        await reload()
        setToast({ kind: 'ok', text: 'Deleted a bet' })
      } catch (err) {
        showError(err)
      }
    },
    [reload, showError]
  )

  const handleExport = useCallback(() => {
    if (!entries || entries.length === 0) return
    const count = downloadCsv(entries)
    setToast({ kind: 'ok', text: `Exported ${count} ${count === 1 ? 'bet' : 'bets'} to your downloads` })
  }, [entries])

  if (loading) return <Boot />
  if (!session) return <Login />
  if (entries === null) return <Boot />

  return (
    <div className="app">
      <Header
        email={email}
        canExport={entries.length > 0}
        onExport={handleExport}
        onLogToday={() => setModalDate(todayStr())}
        onSignOut={signOut}
      />

      <HeroStats
        entries={entries}
        ym={ym}
        onPrev={() => setYm((m) => addMonths(m, -1))}
        onNext={() => setYm((m) => addMonths(m, 1))}
        onResetMonth={() => setYm(currentMonth())}
      />

      <div className="grid-mid">
        <CalendarView ym={ym} dayMap={dayMap} onDayClick={setModalDate} />
        <BalanceChart entries={entries} />
      </div>

      <HistoryTable entries={entries} onEdit={setModalDate} onDelete={handleDelete} />

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
