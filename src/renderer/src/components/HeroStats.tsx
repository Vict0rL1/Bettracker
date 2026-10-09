import { useMemo } from 'react'
import type { Bet } from '../../../shared/types'
import { monthLabel, monthYearShort, sameMonth, shortDate, currentMonth, type MonthKey } from '../lib/dates'
import { fmtMoney, fmtMoneyCompact, fmtPct, fmtPctSigned, fmtProb, fmtStake } from '../lib/format'
import { useLang } from '../lib/i18n'
import { forMonth, isSmallSample, SMALL_SAMPLE, summarize, type Summary, type WinLoss } from '../lib/stats'
import { ChevronLeftIcon, ChevronRightIcon } from './icons'

interface Props {
  bets: Bet[]
  /** All-time summary, computed once by the app and shared with the chart. */
  lifetime: Summary
  ym: MonthKey
  onPrev: () => void
  onNext: () => void
  onResetMonth: () => void
}

const tone = (n: number): string => (n > 0 ? 'win' : n < 0 ? 'loss' : 'flat')

interface MiniProps {
  label: string
  value: string
  sub: string
  toneClass?: string
  title?: string
}

function Mini({ label, value, sub, toneClass = '', title }: MiniProps) {
  return (
    <div className="mini" title={title}>
      <span className="stat-label">{label}</span>
      <span className={`mini-value ${toneClass}`}>{value}</span>
      <span className="mini-sub">{sub}</span>
    </div>
  )
}

export default function HeroStats({ bets, lifetime, ym, onPrev, onNext, onResetMonth }: Props) {
  const { t, tn } = useLang()
  const month = useMemo(() => summarize(forMonth(bets, ym)), [bets, ym])

  /** "9W–8L" / "9G–8P", with pushes when there are any. */
  const record = (wl: WinLoss): string =>
    `${wl.wins}${t('record.w')}–${wl.losses}${t('record.l')}` + (wl.pushes > 0 ? `–${wl.pushes}${t('record.p')}` : '')

  const onCurrentMonth = sameMonth(ym, currentMonth())
  const monthSub =
    month.bets === 0
      ? t('hero.noBetsMonth')
      : `${tn('day', month.dayCount)} · ${tn('bet', month.bets)} · ${record(month.dayWl)}` +
        (month.pendingCount > 0 ? t('hero.pendingSuffix', { n: month.pendingCount }) : '')

  const { roi, bonus, implied, clv } = lifetime
  const smallSample = roi !== null && isSmallSample(roi.counted)

  // ROI only speaks for the bets that recorded a stake. When that's a subset,
  // its profit differs from lifetime P/L above — "63 of 79 bets" is what stops
  // the two numbers from looking like they contradict each other.
  const roiSub = roi
    ? t('hero.roiSub', {
        profit: fmtMoney(roi.profit),
        staked: fmtStake(roi.staked),
        counted:
          roi.missing > 0
            ? t('hero.roiSubset', { counted: roi.counted, total: tn('bet', roi.counted + roi.missing) })
            : tn('bet', roi.counted)
      })
    : lifetime.bets === 0
      ? t('hero.roiNeedsStake')
      : t('hero.roiNone')

  const lifetimeSub =
    lifetime.bets === 0
      ? t('hero.firstBet')
      : t('hero.lifetimeSub', {
          bets: tn('bet', lifetime.bets),
          days: tn('day', lifetime.dayCount),
          month: monthYearShort(lifetime.first ?? '')
        }) + (lifetime.pendingCount > 0 ? t('hero.riding', { n: lifetime.pendingCount, amount: fmtStake(lifetime.pendingStaked) }) : '')

  return (
    <section className="hero">
      <article className="card stat-card">
        <div className="stat-head">
          <span className="stat-label">{t('hero.monthPL', { month: monthLabel(ym) })}</span>
          <div className="month-nav">
            {!onCurrentMonth && (
              <button type="button" className="chip" onClick={onResetMonth}>
                {t('common.today')}
              </button>
            )}
            <button type="button" className="nav-btn" aria-label={t('hero.prevMonth')} onClick={onPrev}>
              <ChevronLeftIcon />
            </button>
            <button type="button" className="nav-btn" aria-label={t('hero.nextMonth')} onClick={onNext}>
              <ChevronRightIcon />
            </button>
          </div>
        </div>
        <div className={`hero-value ${tone(month.total)}`}>{fmtMoney(month.total)}</div>
        <div className="stat-sub">{monthSub}</div>
      </article>

      <article className="card stat-card">
        <div className="stat-head">
          <span className="stat-label">{t('hero.lifetimePL')}</span>
        </div>
        <div className={`life-value ${tone(lifetime.total)}`}>{fmtMoney(lifetime.total)}</div>
        <div className="stat-sub">{lifetimeSub}</div>
      </article>

      <article className="card stat-card roi-card">
        <div className="stat-head">
          <span className="stat-label">{t('hero.roi')}</span>
          <span className="stat-chips">
            {smallSample && (
              <span className="chip chip-static chip-warn" title={t('hero.smallSampleTitle', { n: roi.counted, min: SMALL_SAMPLE })}>
                {t('hero.smallSample')}
              </span>
            )}
            {lifetime.avgStake !== null && (
              <span className="chip chip-static" title={t('hero.avgStakeTitle')}>
                {t('hero.avgStake', { amount: fmtStake(lifetime.avgStake) })}
              </span>
            )}
          </span>
        </div>
        <div className={`life-value ${roi ? tone(roi.pct) : 'flat'}`}>{roi ? fmtPctSigned(roi.pct) : '—'}</div>
        <div className="stat-sub">
          {roiSub}
          {bonus.count > 0 && (
            <>
              <br />
              <span className="bonus" title={t('hero.bonusTitle')}>
                {t('hero.bonus', { profit: fmtMoney(bonus.profit), freeBets: tn('freeBet', bonus.count) })}
              </span>
            </>
          )}
        </div>
      </article>

      <article className="card mini-card">
        <Mini
          label={t('hero.strike')}
          value={lifetime.strike === null ? '—' : fmtPct(lifetime.strike)}
          sub={
            lifetime.strike === null
              ? t('hero.noDecided')
              : t('hero.strikeSub', { w: lifetime.betWl.wins, l: lifetime.betWl.losses, n: lifetime.strikeN }) +
                (implied ? t('hero.implied', { p: fmtProb(implied.avg) }) : '') +
                (isSmallSample(lifetime.strikeN) ? t('hero.smallSampleSuffix') : '')
          }
          title={implied ? t('hero.strikeTitle', { p: fmtProb(implied.avg), n: implied.n }) : t('hero.strikeTitleNoOdds')}
        />
        <Mini
          label={t('hero.clv')}
          value={clv ? fmtPctSigned(clv.avg) : '—'}
          toneClass={clv ? tone(clv.avg) : ''}
          sub={clv ? t('hero.clvSub', { beat: clv.beat, n: clv.n }) : t('hero.noClv')}
          title={t('hero.clvTitle', { n: clv?.n ?? 0 })}
        />
        <Mini
          label={t('hero.greenDays')}
          value={lifetime.dayRate === null ? '—' : fmtPct(lifetime.dayRate)}
          sub={lifetime.dayRate === null ? t('hero.noDecisive') : t('hero.greenSub', { w: lifetime.dayWl.wins, l: lifetime.dayWl.losses })}
          title={t('hero.greenTitle')}
        />
        <Mini
          label={t('hero.streak')}
          value={lifetime.streak ? `${lifetime.streak.kind}${lifetime.streak.count}` : '—'}
          toneClass={lifetime.streak ? (lifetime.streak.kind === 'W' ? 'win' : 'loss') : ''}
          sub={
            lifetime.streak
              ? t(lifetime.streak.kind === 'W' ? 'hero.streakGreen' : 'hero.streakRed', { days: tn('day', lifetime.streak.count) })
              : t('hero.noDecisive')
          }
        />
        <Mini
          label={t('hero.bestDay')}
          value={lifetime.best ? fmtMoneyCompact(lifetime.best.total) : '—'}
          toneClass={lifetime.best ? 'win' : ''}
          sub={lifetime.best ? shortDate(lifetime.best.date) : t('hero.nothingYet')}
        />
        <Mini
          label={t('hero.worstDay')}
          value={lifetime.worst ? fmtMoneyCompact(lifetime.worst.total) : '—'}
          toneClass={lifetime.worst ? 'loss' : ''}
          sub={lifetime.worst ? shortDate(lifetime.worst.date) : t('hero.nothingYet')}
        />
        <Mini
          label={t('hero.drawdown')}
          value={lifetime.drawdown > 0 ? `-${fmtStake(lifetime.drawdown)}` : '—'}
          toneClass={lifetime.drawdown > 0 ? 'loss' : ''}
          sub={lifetime.drawdown > 0 ? t('hero.drawdownSub') : t('hero.drawdownNone')}
          title={t('hero.drawdownTitle')}
        />
      </article>
    </section>
  )
}
