import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BetEntry, EntryInput } from '../../shared/types'
import BalanceChart from './components/BalanceChart'
import CalendarView from './components/CalendarView'
import EntryModal from './components/EntryModal'
import Header from './components/Header'
import HeroStats from './components/HeroStats'
import HistoryTable from './components/HistoryTable'
import Toast, { type ToastMsg } from './components/Toast'
import Login from './auth/Login'
import { useAuth } from './auth/AuthProvider'
import { deleteEntry, getEntries, subscribeToEntries, upsertEntry } from './data/entries'
import { downloadCsv } from './lib/csv'
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

  // Initial load once signed in.
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

  // Signals a stable state to the smoke/UI harness.
  useEffect(() => {
    if (!loading && (!session || entries !== null)) {
      document.documentElement.dataset.ready = '1'
    }
  }, [loading, session, entries])

  const entryMap = useMemo(() => new Map((entries ?? []).map((e) => [e.date, e])), [entries])

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

  const handleSave = useCallback(
    async (input: EntryInput) => {
      try {
        await upsertEntry(input)
        setModalDate(null)
        await reload()
        setToast({ kind: 'ok', text: `Saved ${humanDate(input.date)}` })
      } catch (err) {
        showError(err)
      }
    },
    [reload, showError]
  )

  const handleDelete = useCallback(
    async (date: string) => {
      try {
        await deleteEntry(date)
        setModalDate(null)
        await reload()
        setToast({ kind: 'ok', text: `Deleted ${humanDate(date)}` })
      } catch (err) {
        showError(err)
      }
    },
    [reload, showError]
  )

  const handleExport = useCallback(() => {
    if (!entries || entries.length === 0) return
    const count = downloadCsv(entries)
    setToast({ kind: 'ok', text: `Exported ${count} ${count === 1 ? 'entry' : 'entries'} to your downloads` })
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
        <CalendarView ym={ym} entryMap={entryMap} onDayClick={setModalDate} />
        <BalanceChart entries={entries} />
      </div>

      <HistoryTable entries={entries} onEdit={setModalDate} onDelete={handleDelete} />

      {modalDate !== null && (
        <EntryModal
          date={modalDate}
          entryMap={entryMap}
          onSave={handleSave}
          onDelete={handleDelete}
          onClose={() => setModalDate(null)}
        />
      )}

      {toast && <Toast msg={toast} onDone={() => setToast(null)} />}
    </div>
  )
}
