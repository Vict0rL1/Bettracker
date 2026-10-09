import { useEffect, useMemo, useRef, useState } from 'react'
import type { Bet, BetStatus, OddsFormat } from '../../../shared/types'
import { humanDate } from '../lib/dates'
import { fmtMoney, fmtPctSigned, fmtStake } from '../lib/format'
import { useLang } from '../lib/i18n'
import { formatOdds } from '../lib/odds'
import { clvOf, tagValues } from '../lib/stats'
import { suggestedAmount } from '../lib/validate'
import { toneOf } from './DayModal'
import { ChevronLeftIcon, ChevronRightIcon, PencilIcon, TrashIcon } from './icons'

interface Props {
  bets: Bet[]
  oddsFormat: OddsFormat
  onEdit: (date: string) => void
  onDelete: (id: string) => void
  /** Settle a pending bet with the result its stake and odds imply, or open it when they can't. */
  onSettle: (bet: Bet, status: BetStatus, amount: number | null) => void
}

type SortKey = 'date' | 'amount' | 'stake' | 'odds'
type SortDir = 'asc' | 'desc'
type ResultFilter = 'all' | BetStatus

const PAGE_SIZE = 25
const SETTLE: readonly BetStatus[] = ['won', 'lost', 'push', 'void']

/** Nulls sort last in either direction: missing data, not the smallest value. */
function compareNullable(a: number | null, b: number | null, dir: number): number {
  if (a === null || b === null) {
    if (a === b) return 0
    return a === null ? 1 : -1
  }
  return (a - b) * dir
}

export default function HistoryTable({ bets, oddsFormat, onEdit, onDelete, onSettle }: Props) {
  const { t, tn } = useLang()
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

  const sports = useMemo(() => tagValues(bets, 'sport'), [bets])
  const books = useMemo(() => tagValues(bets, 'book'), [bets])
  // The CLV column only earns its space once a closing price has been recorded.
  const hasClv = useMemo(() => bets.some((b) => b.closingOdds !== null), [bets])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return bets.filter((b) => {
      if (result !== 'all' && b.status !== result) return false
      if (sport && b.sport !== sport) return false
      if (book && b.book !== book) return false
      if (q && !`${b.note} ${b.sport} ${b.book} ${b.betType} ${b.date}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [bets, query, result, sport, book])

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    const byDate = (a: Bet, b: Bet): number => {
      if (a.date !== b.date) return a.date < b.date ? -dir : dir
      // Same day: keep bets in the order they were logged.
      return a.createdAt < b.createdAt ? -dir : dir
    }
    return [...filtered].sort((a, b) => {
      if (sortKey === 'date') return byDate(a, b)
      const c =
        sortKey === 'stake'
          ? compareNullable(a.stake, b.stake, dir)
          : sortKey === 'odds'
            ? compareNullable(a.odds, b.odds, dir)
            : compareNullable(a.amount, b.amount, dir)
      return c !== 0 ? c : byDate(a, b)
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

  const sortHeader = (key: SortKey, label: string, right = false) => (
    <th className={right ? 'th-right' : undefined}>
      <button type="button" className="th-sort" onClick={() => toggleSort(key)}>
        {label}
        {arrow(key)}
      </button>
    </th>
  )

  return (
    <article className="card history-card">
      <header className="card-head">
        <h2>{t('hist.title')}</h2>
        <span className="card-note">{hasFilters ? t('hist.countOf', { m: filtered.length, bets: tn('bet', bets.length) }) : tn('bet', bets.length)}</span>
      </header>

      {bets.length === 0 ? (
        <div className="empty-state">{t('hist.empty')}</div>
      ) : (
        <>
          <div className="filters">
            <input
              type="search"
              className="filter-search"
              placeholder={t('hist.search')}
              aria-label={t('hist.searchAria')}
              value={query}
              onChange={(e) => resetPage(setQuery)(e.target.value)}
            />
            <select aria-label={t('hist.filterResult')} value={result} onChange={(e) => resetPage(setResult)(e.target.value as ResultFilter)}>
              <option value="all">{t('hist.allResults')}</option>
              <option value="won">{t('statusName.won')}</option>
              <option value="lost">{t('statusName.lost')}</option>
              <option value="push">{t('statusName.push')}</option>
              <option value="void">{t('statusName.void')}</option>
              <option value="pending">{t('statusName.pending')}</option>
            </select>
            {sports.length > 0 && (
              <select aria-label={t('hist.filterSport')} value={sport} onChange={(e) => resetPage(setSport)(e.target.value)}>
                <option value="">{t('hist.allSports')}</option>
                {sports.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            )}
            {books.length > 0 && (
              <select aria-label={t('hist.filterBook')} value={book} onChange={(e) => resetPage(setBook)(e.target.value)}>
                <option value="">{t('hist.allBooks')}</option>
                {books.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            )}
            {hasFilters && (
              <button type="button" className="chip" onClick={clearFilters}>
                {t('hist.clear')}
              </button>
            )}
          </div>

          {sorted.length === 0 ? (
            <div className="empty-state">{t('hist.noMatch')}</div>
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {sortHeader('date', t('hist.date'))}
                      <th>{t('hist.result')}</th>
                      {sortHeader('stake', t('hist.stake'), true)}
                      {sortHeader('odds', t('hist.odds'), true)}
                      {sortHeader('amount', t('hist.amount'), true)}
                      <th className="th-right">{t('hist.return')}</th>
                      {hasClv && <th className="th-right">{t('hist.clv')}</th>}
                      <th>{t('hist.tags')}</th>
                      <th>{t('hist.note')}</th>
                      <th className="th-right">{t('hist.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((b) => {
                      const tone = toneOf(b.status)
                      const decided = b.status === 'won' || b.status === 'lost'
                      const ret = decided && b.amount !== null && b.stake !== null && b.stake > 0 ? (b.amount / b.stake) * 100 : null
                      const clv = b.odds !== null && b.closingOdds !== null ? clvOf(b.odds, b.closingOdds) : null
                      const tags = [b.sport, b.book, b.betType].filter(Boolean)
                      const when = humanDate(b.date)
                      return (
                        <tr key={b.id} className={b.status === 'pending' ? 'is-pending' : undefined}>
                          <td className="td-date">{when}</td>
                          <td>
                            <span className={`pill ${tone}`}>{t(`status.${b.status}`)}</span>
                          </td>
                          <td className="td-stake">{b.stake === null ? <span className="td-none">—</span> : fmtStake(b.stake)}</td>
                          <td className="td-stake td-odds">{b.odds === null ? <span className="td-none">—</span> : formatOdds(b.odds, oddsFormat)}</td>
                          <td className={`td-amt ${tone}`}>{b.amount === null ? <span className="td-none">—</span> : fmtMoney(b.amount)}</td>
                          <td className={`td-roi ${ret === null ? '' : ret > 0 ? 'win' : ret < 0 ? 'loss' : ''}`}>
                            {ret === null ? <span className="td-none">—</span> : fmtPctSigned(ret)}
                          </td>
                          {hasClv && (
                            <td className={`td-roi td-clv ${clv === null ? '' : clv > 0 ? 'win' : clv < 0 ? 'loss' : ''}`}>
                              {clv === null ? <span className="td-none">—</span> : fmtPctSigned(clv)}
                            </td>
                          )}
                          <td className="td-tags">
                            {tags.length === 0 ? (
                              <span className="td-none">—</span>
                            ) : (
                              tags.map((x) => (
                                <span key={x} className="tag">
                                  {x}
                                </span>
                              ))
                            )}
                          </td>
                          <td className="td-note" title={b.note || undefined}>
                            {b.status === 'pending' ? (
                              <span className="settle" role="group" aria-label={t('hist.settleAria', { date: b.date })}>
                                {SETTLE.map((s) => (
                                  <button
                                    key={s}
                                    type="button"
                                    className={`settle-btn ${toneOf(s)}`}
                                    title={t('hist.markAs', { status: t(`statusWord.${s}`) })}
                                    onClick={() => onSettle(b, s, suggestedAmount(s, b.stake, b.odds))}
                                  >
                                    {t(`status.${s}`)}
                                  </button>
                                ))}
                              </span>
                            ) : (
                              b.note || <span className="td-none">—</span>
                            )}
                          </td>
                          <td className="td-actions">
                            <button type="button" className="btn-icon" aria-label={t('hist.editAria', { date: b.date })} title={t('hist.editDay')} onClick={() => onEdit(b.date)}>
                              <PencilIcon />
                            </button>
                            <button
                              type="button"
                              className={`btn-icon danger ${confirming === b.id ? 'confirming' : ''}`}
                              aria-label={t('hist.deleteAria', { date: b.date })}
                              title={confirming === b.id ? t('common.clickAgain') : t('common.delete')}
                              onClick={() => handleDeleteClick(b.id)}
                            >
                              {confirming === b.id ? <span className="confirm-text">{t('common.sure')}</span> : <TrashIcon />}
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
                  <button type="button" className="nav-btn" aria-label={t('hist.prevPage')} disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                    <ChevronLeftIcon />
                  </button>
                  <span className="pager-label">
                    {t('hist.pager', { from: safePage * PAGE_SIZE + 1, to: Math.min(sorted.length, (safePage + 1) * PAGE_SIZE), total: sorted.length })}
                  </span>
                  <button
                    type="button"
                    className="nav-btn"
                    aria-label={t('hist.nextPage')}
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
