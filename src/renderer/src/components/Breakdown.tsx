import { useMemo, useState } from 'react'
import type { BetEntry } from '../../../shared/types'
import { fmtMoney, fmtPctSigned, fmtStake } from '../lib/format'
import { breakdown, type TagKey } from '../lib/stats'

interface Props {
  entries: BetEntry[]
}

const TABS: { key: TagKey; label: string; empty: string }[] = [
  { key: 'sport', label: 'Sport', empty: 'sport' },
  { key: 'book', label: 'Book', empty: 'bookmaker' },
  { key: 'betType', label: 'Bet type', empty: 'bet type' }
]

const tone = (n: number): string => (n > 0 ? 'win' : n < 0 ? 'loss' : 'push')

export default function Breakdown({ entries }: Props) {
  const [tab, setTab] = useState<TagKey>('sport')
  const rows = useMemo(() => breakdown(entries, tab), [entries, tab])
  const active = TABS.find((t) => t.key === tab) ?? TABS[0]

  // The widest slice sets the bar scale, so the bars compare rows against each
  // other rather than against an arbitrary fixed maximum.
  const peak = useMemo(() => Math.max(1, ...rows.map((r) => Math.abs(r.profit))), [rows])

  return (
    <article className="card breakdown-card">
      <header className="card-head">
        <h2>Breakdown</h2>
        <div className="scope-toggle" role="group" aria-label="Group breakdown by">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`scope-btn ${tab === t.key ? 'active' : ''}`}
              aria-pressed={tab === t.key}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="empty-state">
          No bets tagged with a {active.empty} yet. Add one when you log a bet to see how each {active.empty} performs.
        </div>
      ) : (
        <ul className="bd-list">
          {rows.map((r) => (
            <li key={r.label} className="bd-row">
              <div className="bd-main">
                <span className="bd-label" title={r.label}>
                  {r.label}
                </span>
                <span className={`bd-profit ${tone(r.profit)}`}>{fmtMoney(r.profit)}</span>
              </div>
              <div className="bd-bar" aria-hidden="true">
                <span
                  className={`bd-fill ${tone(r.profit)}`}
                  style={{ width: `${(Math.abs(r.profit) / peak) * 100}%` }}
                />
              </div>
              <div className="bd-meta">
                <span>
                  {r.bets} {r.bets === 1 ? 'bet' : 'bets'} · {r.wl.wins}W–{r.wl.losses}L
                  {r.wl.pushes > 0 ? `–${r.wl.pushes}P` : ''}
                </span>
                <span
                  className={r.roi === null ? '' : tone(r.roi)}
                  title={
                    r.roi === null
                      ? 'None of these bets recorded a stake, so ROI cannot be computed'
                      : r.roiBets < r.bets
                        ? `ROI covers the ${r.roiBets} of ${r.bets} bets with a recorded stake — the profit above covers all ${r.bets}`
                        : `ROI across all ${r.bets} bets`
                  }
                >
                  {r.roi === null
                    ? 'no stakes logged'
                    : `${fmtPctSigned(r.roi)} on ${fmtStake(r.staked)}${r.roiBets < r.bets ? ` (${r.roiBets}/${r.bets})` : ''}`}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}
