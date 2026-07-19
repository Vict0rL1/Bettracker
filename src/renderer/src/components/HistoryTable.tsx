import { useEffect, useMemo, useRef, useState } from 'react'
import type { BetEntry } from '../../../shared/types'
import { humanDate } from '../lib/dates'
import { fmtMoney } from '../lib/format'
import { PencilIcon, TrashIcon } from './icons'

interface Props {
  entries: BetEntry[]
  onEdit: (date: string) => void
  onDelete: (id: string) => void
}

type SortKey = 'date' | 'amount'
type SortDir = 'asc' | 'desc'

const kindOf = (amount: number): 'win' | 'loss' | 'push' => (amount > 0 ? 'win' : amount < 0 ? 'loss' : 'push')
const KIND_LABEL = { win: 'WIN', loss: 'LOSS', push: 'PUSH' } as const

export default function HistoryTable({ entries, onEdit, onDelete }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [confirming, setConfirming] = useState<string | null>(null)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
  }, [])

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...entries].sort((a, b) => {
      if (sortKey === 'date') {
        if (a.date !== b.date) return a.date < b.date ? -dir : dir
        // Same day: keep sessions in the order they were logged.
        return a.createdAt < b.createdAt ? -dir : dir
      }
      if (a.amount !== b.amount) return (a.amount - b.amount) * dir
      return a.date < b.date ? -dir : dir
    })
  }, [entries, sortKey, sortDir])

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const handleDeleteClick = (id: string) => {
    if (confirming === id) {
      setConfirming(null)
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
      onDelete(id)
      return
    }
    setConfirming(id)
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    confirmTimer.current = setTimeout(() => setConfirming(null), 3000)
  }

  const arrow = (key: SortKey): string => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '')

  return (
    <article className="card history-card">
      <header className="card-head">
        <h2>History</h2>
        <span className="card-note">
          {entries.length} {entries.length === 1 ? 'bet' : 'bets'}
        </span>
      </header>

      {entries.length === 0 ? (
        <div className="empty-state">No bets logged yet. Hit “Log today” or click a day on the calendar.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>
                  <button type="button" className="th-sort" onClick={() => toggleSort('date')}>
                    Date{arrow('date')}
                  </button>
                </th>
                <th>Result</th>
                <th className="th-right">
                  <button type="button" className="th-sort" onClick={() => toggleSort('amount')}>
                    Amount{arrow('amount')}
                  </button>
                </th>
                <th>Note</th>
                <th className="th-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((e) => {
                const kind = kindOf(e.amount)
                return (
                  <tr key={e.id}>
                    <td className="td-date">{humanDate(e.date)}</td>
                    <td>
                      <span className={`pill ${kind}`}>{KIND_LABEL[kind]}</span>
                    </td>
                    <td className={`td-amt ${kind}`}>{fmtMoney(e.amount)}</td>
                    <td className="td-note" title={e.note || undefined}>
                      {e.note || <span className="td-none">—</span>}
                    </td>
                    <td className="td-actions">
                      <button
                        type="button"
                        className="btn-icon"
                        aria-label={`Edit ${e.date}`}
                        title="Edit this day"
                        onClick={() => onEdit(e.date)}
                      >
                        <PencilIcon />
                      </button>
                      <button
                        type="button"
                        className={`btn-icon danger ${confirming === e.id ? 'confirming' : ''}`}
                        aria-label={`Delete bet on ${e.date}`}
                        title={confirming === e.id ? 'Click again to confirm' : 'Delete'}
                        onClick={() => handleDeleteClick(e.id)}
                      >
                        {confirming === e.id ? <span className="confirm-text">Sure?</span> : <TrashIcon />}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </article>
  )
}
