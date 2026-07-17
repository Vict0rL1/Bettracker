import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BetEntry, EntryInput } from '../../shared/types'
import BalanceChart from './components/BalanceChart'
import CalendarView from './components/CalendarView'
import EntryModal from './components/EntryModal'
import Header from './components/Header'
import HeroStats from './components/HeroStats'
import HistoryTable from './components/HistoryTable'
import Toast, { type ToastMsg } from './components/Toast'
import { addMonths, currentMonth, humanDate, todayStr, type MonthKey } from './lib/dates'

const cleanIpcError = (msg: string): string =>
  msg.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')

export default function App() {
  const [entries, setEntries] = useState<BetEntry[] | null>(null)
  const [ym, setYm] = useState<MonthKey>(currentMonth)
  const [modalDate, setModalDate] = useState<string | null>(null)
  const [toast, setToast] = useState<ToastMsg | null>(null)

  const showError = useCallback((err: unknown) => {
    const text = err instanceof Error ? cleanIpcError(err.message) : 'Something went wrong'
    setToast({ kind: 'error', text })
  }, [])

  const reload = useCallback(async () => {
    setEntries(await window.api.getEntries())
  }, [])

  useEffect(() => {
    reload().catch(showError)
  }, [reload, showError])

  // Lets the smoke test (and packagers sanity-checking a build) detect a live UI.
  useEffect(() => {
    if (entries) document.documentElement.dataset.ready = '1'
  }, [entries])

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
        await window.api.upsertEntry(input)
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
        await window.api.deleteEntry(date)
        setModalDate(null)
        await reload()
        setToast({ kind: 'ok', text: `Deleted ${humanDate(date)}` })
      } catch (err) {
        showError(err)
      }
    },
    [reload, showError]
  )

  const handleExport = useCallback(async () => {
    try {
      const result = await window.api.exportCsv()
      if (result.ok) {
        setToast({
          kind: 'ok',
          text: `Exported ${result.count} ${result.count === 1 ? 'entry' : 'entries'} to ${result.path}`
        })
      }
    } catch (err) {
      showError(err)
    }
  }, [showError])

  if (entries === null) {
    return (
      <div className="boot">
        <span>
          Bet<span className="boot-accent">Tracker</span>
        </span>
      </div>
    )
  }

  return (
    <div className="app">
      <Header
        canExport={entries.length > 0}
        onExport={handleExport}
        onLogToday={() => setModalDate(todayStr())}
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
