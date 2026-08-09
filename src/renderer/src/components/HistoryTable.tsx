import { useEffect, useMemo, useRef, useState } from 'react'
import type { BetEntry } from '../../../shared/types'
import { humanDate } from '../lib/dates'
import { fmtMoney, fmtPctSigned, fmtStake } from '../lib/format'
import { tagValues } from '../lib/stats'
import { ChevronLeftIcon, ChevronRightIcon, PencilIcon, TrashIcon } from './icons'

interface Props {
  entries: BetEntry[]
  onEdit: (date: string) => void
  onDelete: (id: string) => void
}

type SortKey = 'date' | 'amount' | 'stake'
type SortDir = 'asc' | 'desc'
type ResultFilter = 'all' | 'win' | 'loss' | 'push'

const PAGE_SIZE = 25

const kindOf = (amount: number): 'win' | 'loss' | 'push' => (amount > 0 ? 'win' : amount < 0 ? 'loss' : 'push')
const KIND_LABEL = { win: 'WIN', loss: 'LOSS', push: 'PUSH' } as const

export default function HistoryTable({ entries, onEdit, onDelete }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<ResultFilter>('all')
  const [sport, setSport] = useState('')
  const [book, setBook] = useState('')
  const [page, setPage] = useState(0)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
    },
    []
  )

  const sports = useMemo(() => tagValues(entries, 'sport'), [entries])
  const books = useMemo(() => tagValues(entries, 'book'), [entries])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries.filter((e) => {
      if (result !== 'all' && kindOf(e.amount) !== result) return false
      if (sport && e.sport !== sport) return false
      if (book && e.book !== book) return false
      if (q && !`${e.note} ${e.sport} ${e.book} ${e.betType} ${e.date}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [entries, query, result, sport, book])

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      if (sortKey === 'date') {
        if (a.date !== b.date) return a.date < b.date ? -dir : dir
        // Same day: keep sessions in the order they were logged.
        return a.createdAt < b.createdAt ? -dir : dir
      }
      if (sortKey === 'stake') {
        // Rows without a stake sort last in either direction — they're missing
        // data, not the smallest bet.
        if (a.stake === null || b.stake === null) {
          if (a.stake === b.stake) return a.date < b.date ? -dir : dir
          return a.stake === null ? 1 : -1
        }
        if (a.stake !== b.stake) return (a.stake - b.stake) * dir
        return a.date < b.date ? -dir : dir
      }
      if (a.amount !== b.amount) return (a.amount - b.amount) * dir
      return a.date < b.date ? -dir : dir
    })
  }, [filtered, sortKey, sortDir])

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  // Filtering can shrink the list under the current page — clamp instead of
  // rendering a blank table.
  const safePage = Math.min(page, pageCount - 1)
  const visible = sorted.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

  const resetPage = <T,>(setter: (v: T) => void) => (value: T) => {
    setter(value)
    setPage(0)
  }

  const toggleSort = (key: SortKey): void => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
    setPage(0)
  }

  const handleDeleteClick = (id: string): void => {
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

  const hasFilters = query !== '' || result !== 'all' || sport !== '' || book !== ''
  const clearFilters = (): void => {
    setQuery('')
    setResult('all')
    setSport('')
    setBook('')
    setPage(0)
  }

  return (
    <article className="card history-card">
      <header className="card-head">
        <h2>History</h2>
        <span className="card-note">
          {hasFilters
            ? `${filtered.length} of ${entries.length} ${entries.length === 1 ? 'bet' : 'bets'}`
            : `${entries.length} ${entries.length === 1 ? 'bet' : 'bets'}`}
        </span>
      </header>

      {entries.length === 0 ? (
        <div className="empty-state">No bets logged yet. Hit “Log today” or click a day on the calendar.</div>
      ) : (
        <>
          <div className="filters">
            <input
              type="search"
              className="filter-search"
              placeholder="Search notes, tags, dates…"
              aria-label="Search bets"
              value={query}
              onChange={(e) => resetPage(setQuery)(e.target.value)}
            />
            <select
              aria-label="Filter by result"
              value={result}
              onChange={(e) => resetPage(setResult)(e.target.value as ResultFilter)}
            >
              <option value="all">All results</option>
              <option value="win">Wins</option>
              <option value="loss">Losses</option>
              <option value="push">Pushes</option>
            </select>
            {sports.length > 0 && (
              <select aria-label="Filter by sport" value={sport} onChange={(e) => resetPage(setSport)(e.target.value)}>
                <option value="">All sports</option>
                {sports.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            )}
            {books.length > 0 && (
              <select aria-label="Filter by book" value={book} onChange={(e) => resetPage(setBook)(e.target.value)}>
                <option value="">All books</option>
                {books.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            )}
            {hasFilters && (
              <button type="button" className="chip" onClick={clearFilters}>
                Clear
              </button>
            )}
          </div>

          {sorted.length === 0 ? (
            <div className="empty-state">No bets match these filters.</div>
          ) : (
            <>
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
                        <button type="button" className="th-sort" onClick={() => toggleSort('stake')}>
                          Stake{arrow('stake')}
                        </button>
                      </th>
                      <th className="th-right">
                        <button type="button" className="th-sort" onClick={() => toggleSort('amount')}>
                          Amount{arrow('amount')}
                        </button>
                      </th>
                      <th className="th-right">ROI</th>
                      <th>Tags</th>
                      <th>Note</th>
                      <th className="th-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((e) => {
                      const kind = kindOf(e.amount)
                      const roi = e.stake !== null && e.stake > 0 ? (e.amount / e.stake) * 100 : null
                      const tags = [e.sport, e.book, e.betType].filter(Boolean)
                      return (
                        <tr key={e.id}>
                          <td className="td-date">{humanDate(e.date)}</td>
                          <td>
                            <span className={`pill ${kind}`}>{KIND_LABEL[kind]}</span>
                          </td>
                          <td className="td-stake">
                            {e.stake === null ? <span className="td-none">—</span> : fmtStake(e.stake)}
                          </td>
                          <td className={`td-amt ${kind}`}>{fmtMoney(e.amount)}</td>
                          <td className={`td-roi ${roi === null ? '' : kindOf(roi)}`}>
                            {roi === null ? <span className="td-none">—</span> : fmtPctSigned(roi)}
                          </td>
                          <td className="td-tags">
                            {tags.length === 0 ? (
                              <span className="td-none">—</span>
                            ) : (
                              tags.map((t) => (
                                <span key={t} className="tag">
                                  {t}
                                </span>
                              ))
                            )}
                          </td>
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

              {pageCount > 1 && (
                <footer className="pager">
                  <button
                    type="button"
                    className="nav-btn"
                    aria-label="Previous page"
                    disabled={safePage === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                  >
                    <ChevronLeftIcon />
                  </button>
                  <span className="pager-label">
                    {safePage * PAGE_SIZE + 1}–{Math.min(sorted.length, (safePage + 1) * PAGE_SIZE)} of {sorted.length}
                  </span>
                  <button
                    type="button"
                    className="nav-btn"
                    aria-label="Next page"
                    disabled={safePage >= pageCount - 1}
                    onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  >
                    <ChevronRightIcon />
                  </button>
                </footer>
              )}
            </>
          )}
        </>
      )}
    </article>
  )
}
