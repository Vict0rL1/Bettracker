import { useMemo } from 'react'
import type { Bet } from '../../../shared/types'
import type { Bankroll } from '../lib/bankroll'
import { monthLabel, monthYearShort, sameMonth, shortDate, currentMonth, type MonthKey } from '../lib/dates'
import { fmtMoney, fmtMoneyPlain, fmtPct, fmtPctSigned, fmtProb } from '../lib/format'
import { useLang } from '../lib/i18n'
import { useMoney } from '../lib/money'
import { forMonth, isSmallSample, SMALL_SAMPLE, summarize, type Summary, type WinLoss } from '../lib/stats'
import { ChevronLeftIcon, ChevronRightIcon } from './icons'

interface Props {
  bets: Bet[]
  /** Summary over the chosen date range (all time by default), shared with the chart. */
  lifetime: Summary
  /** The range's name when one is chosen, null for all time. */
  rangeName: string | null
  ym: MonthKey
  /** Always over every bet, whatever the range: a bankroll is a balance, not a period. */
  bankroll: Bankroll
  /** No session or no connection: a bankroll still loading waits for one. */
  offline: boolean
  onPrev: () => void
  onNext: () => void
  onResetMonth: () => void
  onOpenBankroll: () => void
}

const tone = (n: number): string => (n > 0 ? 'win' : n < 0 ? 'loss' : 'flat')

interface MiniProps {
  label: string
  value: string
  sub: string
  toneClass?: string
  title?: string
  /** Makes the whole tile a button. */
  onClick?: () => void
  className?: string
}

function Mini({ label, value, sub, toneClass = '', title, onClick, className = '' }: MiniProps) {
  const body = (
    <>
      <span className="stat-label">{label}</span>
      <span className={`mini-value ${toneClass}`}>{value}</span>
      <span className="mini-sub">{sub}</span>
    </>
  )
  return onClick ? (
    <button type="button" className={`mini mini-btn ${className}`} title={title} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={`mini ${className}`} title={title}>
      {body}
    </div>
  )
}

export default function HeroStats({ bets, lifetime, rangeName, ym, bankroll, offline, onPrev, onNext, onResetMonth, onOpenBankroll }: Props) {
  const { t, tn } = useLang()
  const money = useMoney()
  // In units the big figures carry the exact dollars on hover.
  const dollarsTitle = (n: number): string | undefined => (money.unit === null ? undefined : fmtMoney(n))
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
        profit: money.signed(roi.profit),
        staked: money.stake(roi.staked),
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
        }) + (lifetime.pendingCount > 0 ? t('hero.riding', { n: lifetime.pendingCount, amount: money.stake(lifetime.pendingStaked) }) : '')

  const bankrollValue = bankroll.known ? money.bankroll(bankroll.current) : bankroll.reason === 'unset' ? '—' : '…'
  const bankrollSub = bankroll.known
    ? bankroll.inPlay > 0
      ? t('hero.bankrollRiding', { amount: money.stake(bankroll.inPlay) })
      : t('hero.bankrollFunded', { amount: money.bankroll(bankroll.funded) })
    : bankroll.reason === 'unset'
      ? t('hero.bankrollSetUp')
      : t(offline ? 'hero.bankrollOffline' : 'hero.bankrollLoading')

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
        <div className={`hero-value ${tone(month.total)}`} title={dollarsTitle(month.total)}>
          {money.signed(month.total)}
        </div>
        <div className="stat-sub">{monthSub}</div>
      </article>

      <article className="card stat-card">
        <div className="stat-head">
          <span className="stat-label">{rangeName ? t('hero.rangePL', { range: rangeName }) : t('hero.lifetimePL')}</span>
        </div>
        <div className={`life-value ${tone(lifetime.total)}`} title={dollarsTitle(lifetime.total)}>
          {money.signed(lifetime.total)}
        </div>
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
                {t('hero.avgStake', { amount: money.stake(lifetime.avgStake) })}
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
                {t('hero.bonus', { profit: money.signed(bonus.profit), freeBets: tn('freeBet', bonus.count) })}
              </span>
            </>
          )}
        </div>
      </article>

      <article className="card mini-card">
        <Mini
          className="mini-bankroll"
          label={t('hero.bankroll')}
          value={bankrollValue}
          toneClass={bankroll.known && bankroll.current <= 0 ? 'loss' : ''}
          sub={bankrollSub}
          title={t('hero.bankrollTitle') + (bankroll.known && money.unit !== null ? ` (${fmtMoneyPlain(bankroll.current)})` : '')}
          onClick={onOpenBankroll}
        />
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
          value={lifetime.best ? money.compact(lifetime.best.total) : '—'}
          toneClass={lifetime.best ? 'win' : ''}
          sub={lifetime.best ? shortDate(lifetime.best.date) : t('hero.nothingYet')}
        />
        <Mini
          label={t('hero.worstDay')}
          value={lifetime.worst ? money.compact(lifetime.worst.total) : '—'}
          toneClass={lifetime.worst ? 'loss' : ''}
          sub={lifetime.worst ? shortDate(lifetime.worst.date) : t('hero.nothingYet')}
        />
        <Mini
          label={t('hero.drawdown')}
          value={lifetime.drawdown > 0 ? `-${money.stake(lifetime.drawdown)}` : '—'}
          toneClass={lifetime.drawdown > 0 ? 'loss' : ''}
          sub={lifetime.drawdown > 0 ? t('hero.drawdownSub') : t('hero.drawdownNone')}
          title={t('hero.drawdownTitle')}
        />
      </article>
    </section>
  )
}
