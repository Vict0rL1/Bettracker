import { useMemo, useState } from 'react'
import type { Bet, OddsFormat } from '../../../shared/types'
import { bandBounds, bandRangeText, type BandKey } from '../lib/bands'
import { monthYearShort } from '../lib/dates'
import { fmtMoney, fmtPctSigned, fmtStake } from '../lib/format'
import { useLang } from '../lib/i18n'
import { breakdown, GROUPINGS, type Grouping, type TagKey } from '../lib/stats'
import type { StringKey } from '../lib/strings'

interface Props {
  bets: Bet[]
  oddsFormat: OddsFormat
}

const TAB_LABEL: Record<Grouping, StringKey> = {
  sport: 'bd.sport',
  book: 'bd.book',
  betType: 'bd.betType',
  odds: 'bd.odds',
  weekday: 'bd.weekday',
  month: 'bd.month'
}

const TAG_WORD: Record<TagKey, StringKey> = { sport: 'bd.sportWord', book: 'bd.bookWord', betType: 'bd.betTypeWord' }

const isTag = (g: Grouping): g is TagKey => g === 'sport' || g === 'book' || g === 'betType'

const tone = (n: number): string => (n > 0 ? 'win' : n < 0 ? 'loss' : 'push')

export default function Breakdown({ bets, oddsFormat }: Props) {
  const { t, tn } = useLang()
  const [tab, setTab] = useState<Grouping>('sport')
  const rows = useMemo(() => breakdown(bets, tab), [bets, tab])

  // The widest slice sets the bar scale, so the bars compare rows against each
  // other rather than against an arbitrary fixed maximum.
  const peak = useMemo(() => Math.max(1, ...rows.map((r) => Math.abs(r.profit))), [rows])

  const weekdays = t('bd.weekdayNames').split(',')

  /** The row key in words: a tag as is, a band with its edges, a weekday name, "Aug 2026". */
  const labelOf = (key: string): string => {
    switch (tab) {
      case 'odds':
        return `${t(`band.${key as BandKey}`)} · ${bandRangeText(key as BandKey, oddsFormat)}`
      case 'weekday':
        return weekdays[Number(key)] ?? key
      case 'month':
        return monthYearShort(`${key}-01`)
      default:
        return key
    }
  }

  /** For the odds tab, the exact decimal edges, since the label shows rounded prices. */
  const titleOf = (key: string): string => {
    if (tab !== 'odds') return labelOf(key)
    const { lo, hi } = bandBounds(key as BandKey)
    const range = lo === 1 ? `≤ ${hi.toFixed(2)}` : hi === Infinity ? `> ${lo.toFixed(2)}` : `${lo.toFixed(2)} < … ≤ ${hi.toFixed(2)}`
    return t('bd.bandTitle', { range })
  }

  const emptyText = isTag(tab) ? t('bd.empty', { what: t(TAG_WORD[tab]) }) : tab === 'odds' ? t('bd.emptyOdds') : t('bd.emptyDates')

  return (
    <article className="card breakdown-card">
      <header className="card-head">
        <h2>{t('bd.title')}</h2>
        <div className="scope-toggle bd-tabs" role="group" aria-label={t('bd.groupBy')}>
          {GROUPINGS.map((g) => (
            <button key={g} type="button" className={`scope-btn ${tab === g ? 'active' : ''}`} aria-pressed={tab === g} onClick={() => setTab(g)}>
              {t(TAB_LABEL[g])}
            </button>
          ))}
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="empty-state">{emptyText}</div>
      ) : (
        <ul className="bd-list">
          {rows.map((r) => (
            <li key={r.label} className="bd-row">
              <div className="bd-main">
                <span className="bd-label" title={titleOf(r.label)}>
                  {labelOf(r.label)}
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
                {r.clv !== null && (
                  <span className={`bd-clv ${tone(r.clv)}`} title={t('bd.clvTitle', { n: r.clvBets })}>
                    {t('bd.clv', { pct: fmtPctSigned(r.clv) })}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}
