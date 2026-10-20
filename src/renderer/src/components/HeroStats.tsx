import { useId, useMemo, useState, type ReactNode } from 'react'
import type { Bet } from '../../../shared/types'
import type { Bankroll } from '../lib/bankroll'
import { monthLabel, monthYearShort, sameMonth, shortDate, currentMonth, type MonthKey } from '../lib/dates'
import { fmtMoney, fmtMoneyPlain, fmtPct, fmtPctSigned, fmtProb } from '../lib/format'
import { useLang } from '../lib/i18n'
import { useMoney } from '../lib/money'
import type { OpenBet } from '../lib/pending'
import { forMonth, isSmallSample, round2, SMALL_SAMPLE, summarize, type Summary, type WinLoss } from '../lib/stats'
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from './icons'

/*
 * The dashboard's numbers, in order of how often they are wanted:
 *  - KeyStats: P/L over the chosen range, the bankroll, and the bets still
 *    waiting for a result, first and largest;
 *  - HeroStats: the month (with its own month to month navigation) and ROI;
 *  - AdvancedStats: the rest (strike rate, CLV, winning days, streak, best
 *    and worst day, drawdown), in a section that opens on demand.
 * Each says what it covers: the chosen range, or all dates.
 */

interface KeyProps {
  /** Summary over the chosen date range (all time by default), shared with the chart. */
  lifetime: Summary
  /** The range's name when one is chosen, null for all time. */
  rangeName: string | null
  /** Always over every bet, whatever the range: a bankroll is a balance, not a period. */
  bankroll: Bankroll
  /** No session or no connection: a bankroll still loading waits for one. */
  offline: boolean
  /** The bets waiting for a result, all dates. */
  open: readonly OpenBet[]
  onOpenBankroll: () => void
  onOpenPending: () => void
}

interface HeroProps {
  bets: Bet[]
  lifetime: Summary
  rangeName: string | null
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

/** What a number covers: the chosen range, or every date whatever the range. */
function Scope({ range }: { range: string | null | 'all-dates' }) {
  const { t } = useLang()
  const text = range === 'all-dates' ? t('scope.allDates') : (range ?? t('range.all'))
  return (
    <span className="scope-tag" title={range === 'all-dates' ? t('scope.allDatesTitle') : t('scope.rangeTitle')}>
      {text}
    </span>
  )
}

/** P/L over the range, the bankroll, the bets still open: what is looked at most. */
export function KeyStats({ lifetime, rangeName, bankroll, offline, open, onOpenBankroll, onOpenPending }: KeyProps) {
  const { t, tn } = useLang()
  const money = useMoney()
  const dollarsTitle = (n: number): string | undefined => (money.unit === null ? undefined : fmtMoney(n))

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
      : bankroll.funded < 0
        ? t('hero.bankrollTakenOut', { amount: money.bankroll(-bankroll.funded) })
        : t('hero.bankrollFunded', { amount: money.bankroll(bankroll.funded) })
    : bankroll.reason === 'unset'
      ? t('hero.bankrollSetUp')
      : t(offline ? 'hero.bankrollOffline' : 'hero.bankrollLoading')

  const atRisk = round2(open.reduce((sum, o) => sum + (o.bet.stake ?? 0), 0))
  const past = open.filter((o) => o.past).length
  const pendingSub =
    open.length === 0
      ? t('key.pendingNone')
      : t('key.pendingSub', { amount: money.stake(atRisk) }) + (past > 0 ? t('key.pendingPast', { n: past }) : '')

  return (
    <section className="hero key-stats" aria-label={t('key.aria')}>
      <article className="card stat-card pl-card">
        <div className="stat-head">
          <span className="stat-label">{rangeName ? t('hero.rangePL', { range: rangeName }) : t('hero.lifetimePL')}</span>
        </div>
        <div className={`life-value ${tone(lifetime.total)}`} title={dollarsTitle(lifetime.total)}>
          {money.signed(lifetime.total)}
        </div>
        <div className="stat-sub">{lifetimeSub}</div>
      </article>

      <button
        type="button"
        className="card stat-card key-card bankroll-card"
        title={t('hero.bankrollTitle') + (bankroll.known && money.unit !== null ? ` (${fmtMoneyPlain(bankroll.current)})` : '')}
        onClick={onOpenBankroll}
      >
        <span className="stat-head">
          <span className="stat-label">{t('hero.bankroll')}</span>
          <Scope range="all-dates" />
        </span>
        <span className={`life-value key-value ${bankroll.known && bankroll.current <= 0 ? 'loss' : ''}`}>{bankrollValue}</span>
        <span className="stat-sub key-sub">{bankrollSub}</span>
      </button>

      <button type="button" className={`card stat-card key-card pending-card ${open.length > 0 ? 'has-open' : ''}`} title={t('key.pendingTitle')} onClick={onOpenPending}>
        <span className="stat-head">
          <span className="stat-label">{t('key.pending')}</span>
          <Scope range="all-dates" />
        </span>
        <span className="life-value key-value">{open.length}</span>
        <span className="stat-sub key-sub">{pendingSub}</span>
      </button>
    </section>
  )
}

/** The month (navigable on its own) and ROI over the range. */
export default function HeroStats({ bets, lifetime, rangeName, ym, onPrev, onNext, onResetMonth }: HeroProps) {
  const { t, tn } = useLang()
  const money = useMoney()
  // In units the big figures carry the exact dollars on hover.
  const dollarsTitle = (n: number): string | undefined => (money.unit === null ? undefined : fmtMoney(n))
  const month = useMemo(() => summarize(forMonth(bets, ym)), [bets, ym])

  const onCurrentMonth = sameMonth(ym, currentMonth())
  const monthSub =
    month.bets === 0
      ? t('hero.noBetsMonth')
      : `${tn('bet', month.bets)} · ${t('hero.daysRecord', { w: month.dayWl.wins, l: month.dayWl.losses })}` +
        (month.pendingCount > 0 ? t('hero.pendingSuffix', { n: month.pendingCount }) : '')

  const { roi, bonus } = lifetime
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

  return (
    <section className="hero hero-2">
      <article className="card stat-card month-card">
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

      <article className="card stat-card roi-card">
        <div className="stat-head">
          <span className="stat-label">{t('hero.roi')}</span>
          <span className="stat-chips">
            <Scope range={rangeName} />
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
    </section>
  )
}

/**
 * The rest of the numbers, over the range: bets (strike rate, against the
 * break-even rate of the bets with odds, each with how many it covers), CLV,
 * days (winning days, streaks, best and worst), and drawdown. Days and bets
 * are kept apart in the words: a winning day can hold losing bets.
 */
export function AdvancedStats({ lifetime }: { lifetime: Summary }) {
  const { t, tn } = useLang()
  const money = useMoney()
  const { implied, clv } = lifetime

  /** "9W–8L" / "9G–8P", with pushes when there are any. */
  const record = (wl: WinLoss): string =>
    `${wl.wins}${t('record.w')}–${wl.losses}${t('record.l')}` + (wl.pushes > 0 ? `–${wl.pushes}${t('record.p')}` : '')

  return (
    <div className="card mini-card">
      <Mini
        className="mini-strike"
        label={t('hero.strike')}
        value={lifetime.strike === null ? '—' : fmtPct(lifetime.strike)}
        sub={
          lifetime.strike === null
            ? t('hero.noDecided')
            : t('hero.strikeSub', { record: record(lifetime.betWl), n: lifetime.strikeN }) + (isSmallSample(lifetime.strikeN) ? t('hero.smallSampleSuffix') : '')
        }
        title={implied ? t('hero.strikeTitle', { p: fmtProb(implied.avg), n: implied.n }) : t('hero.strikeTitleNoOdds')}
      />
      {/* Its own tile, with its own count: it covers only the settled bets with odds, often fewer than the strike rate's. */}
      <Mini
        className="mini-implied"
        label={t('hero.breakEven')}
        value={implied ? fmtProb(implied.avg) : '—'}
        sub={implied ? t('hero.breakEvenSub', { n: implied.n }) : t('hero.breakEvenNone')}
        title={t('hero.breakEvenTitle')}
      />
      <Mini
        label={t('hero.clv')}
        value={clv ? fmtPctSigned(clv.avg) : '—'}
        toneClass={clv ? tone(clv.avg) : ''}
        sub={clv ? t('hero.clvSub', { beat: clv.beat, n: clv.n }) : t('hero.noClv')}
        title={t('hero.clvTitle', { n: clv?.n ?? 0 })}
      />
      <Mini
        className="mini-days"
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
    </div>
  )
}

const ADVANCED_KEY = 'bettracker:advanced-open'

/** Whether the advanced section was left open on this device. */
function loadAdvancedOpen(): boolean {
  try {
    return localStorage.getItem(ADVANCED_KEY) === '1'
  } catch {
    return false
  }
}

/** The advanced section: closed until opened, and remembered per device. */
export function AdvancedSection({ rangeName, children }: { rangeName: string | null; children: ReactNode }) {
  const { t } = useLang()
  const [open, setOpen] = useState(loadAdvancedOpen)
  const id = useId()
  const toggle = (): void => {
    setOpen((o) => {
      try {
        localStorage.setItem(ADVANCED_KEY, o ? '0' : '1')
      } catch {
        // Not remembered: it still opens.
      }
      return !o
    })
  }
  return (
    <section className={`advanced ${open ? 'is-open' : ''}`}>
      <h2 className="advanced-head">
        <button type="button" className="advanced-toggle" aria-expanded={open} aria-controls={id} onClick={toggle}>
          <span className="advanced-title">{t('adv.title')}</span>
          <Scope range={rangeName} />
          <span className="advanced-hint">{t('adv.hint')}</span>
          <ChevronDownIcon />
        </button>
      </h2>
      <div id={id} className="advanced-body" hidden={!open}>
        {children}
      </div>
    </section>
  )
}
