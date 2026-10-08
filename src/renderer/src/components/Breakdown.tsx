import { useMemo, useState } from 'react'
import type { Bet } from '../../../shared/types'
import { fmtMoney, fmtPctSigned, fmtStake } from '../lib/format'
import { useLang } from '../lib/i18n'
import { breakdown, type TagKey } from '../lib/stats'

interface Props {
  bets: Bet[]
}

const TABS: { key: TagKey; label: 'bd.sport' | 'bd.book' | 'bd.betType'; word: 'bd.sportWord' | 'bd.bookWord' | 'bd.betTypeWord' }[] = [
  { key: 'sport', label: 'bd.sport', word: 'bd.sportWord' },
  { key: 'book', label: 'bd.book', word: 'bd.bookWord' },
  { key: 'betType', label: 'bd.betType', word: 'bd.betTypeWord' }
]

const tone = (n: number): string => (n > 0 ? 'win' : n < 0 ? 'loss' : 'push')

export default function Breakdown({ bets }: Props) {
  const { t, tn } = useLang()
  const [tab, setTab] = useState<TagKey>('sport')
  const rows = useMemo(() => breakdown(bets, tab), [bets, tab])
  const active = TABS.find((x) => x.key === tab) ?? TABS[0]

  // The widest slice sets the bar scale, so the bars compare rows against each
  // other rather than against an arbitrary fixed maximum.
  const peak = useMemo(() => Math.max(1, ...rows.map((r) => Math.abs(r.profit))), [rows])

  return (
    <article className="card breakdown-card">
      <header className="card-head">
        <h2>{t('bd.title')}</h2>
        <div className="scope-toggle" role="group" aria-label={t('bd.groupBy')}>
          {TABS.map((x) => (
            <button key={x.key} type="button" className={`scope-btn ${tab === x.key ? 'active' : ''}`} aria-pressed={tab === x.key} onClick={() => setTab(x.key)}>
              {t(x.label)}
            </button>
          ))}
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="empty-state">{t('bd.empty', { what: t(active.word) })}</div>
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
                <span className={`bd-fill ${tone(r.profit)}`} style={{ width: `${(Math.abs(r.profit) / peak) * 100}%` }} />
              </div>
              <div className="bd-meta">
                <span>
                  {tn('bet', r.bets)} · {r.wl.wins}
                  {t('record.w')}–{r.wl.losses}
                  {t('record.l')}
                  {r.wl.pushes > 0 ? `–${r.wl.pushes}${t('record.p')}` : ''}
                  {r.pending > 0 ? t('bd.pending', { n: r.pending }) : ''}
                </span>
                <span
                  className={r.roi === null ? '' : tone(r.roi)}
                  title={
                    r.roi === null
                      ? t('bd.noRoiTitle')
                      : r.roiBets < r.bets
                        ? t('bd.roiSubsetTitle', { roiBets: r.roiBets, bets: r.bets })
                        : t('bd.roiAllTitle', { bets: r.bets })
                  }
                >
                  {r.roi === null
                    ? t('bd.noRoi')
                    : t('bd.roiOn', { pct: fmtPctSigned(r.roi), staked: fmtStake(r.staked) }) + (r.roiBets < r.bets ? ` (${r.roiBets}/${r.bets})` : '')}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}
