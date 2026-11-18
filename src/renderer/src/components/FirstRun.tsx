import { useState } from 'react'
import { ODDS_FORMATS, type OddsFormat } from '../../../shared/types'
import { useLang } from '../lib/i18n'
import { formatOdds } from '../lib/odds'
import { CloseIcon } from './icons'

interface Props {
  userId: string
  /** The bankroll has a starting figure (or a deposit). */
  bankrollSet: boolean
  oddsFormat: OddsFormat
  /** Odds have been in use (bets logged, settings saved): nothing to confirm. */
  oddsSettled: boolean
  hasBets: boolean
  onSetBankroll: () => void
  onPickOdds: (format: OddsFormat) => void
  onAddBet: () => void
}

interface GuideState {
  /** Shown once to this account while it had no bets: a first run. Accounts with bets already never get it. */
  started?: boolean
  /** Hidden for good by the user. */
  dismissed?: boolean
  /** The odds format was looked at and chosen (the default counts once confirmed). */
  odds?: boolean
}

const key = (userId: string): string => `bettracker:guide:${userId}`

function load(userId: string): GuideState {
  try {
    const raw = JSON.parse(localStorage.getItem(key(userId)) ?? '{}') as unknown
    return typeof raw === 'object' && raw !== null ? (raw as GuideState) : {}
  } catch {
    return {}
  }
}

function save(userId: string, state: GuideState): void {
  try {
    localStorage.setItem(key(userId), JSON.stringify(state))
  } catch {
    // Not remembered: it shows again next time, nothing worse.
  }
}

/** The price each format button previews: −110 / 1.91 / 10/11, the one everyone knows. */
const SAMPLE = 1.9091

/**
 * First steps for a new account (one with no bets when it is first opened
 * here), on the dashboard until they are done or hidden: the starting
 * bankroll, how odds are written, the first bet. Each says how, and does it
 * in one click; the guide goes once all three are done.
 */
export default function FirstRun({ userId, bankrollSet, oddsFormat, oddsSettled, hasBets, onSetBankroll, onPickOdds, onAddBet }: Props) {
  const { t } = useLang()
  const [state, setState] = useState<GuideState>(() => {
    const stored = load(userId)
    if (stored.started || hasBets) return stored
    const next = { ...stored, started: true }
    save(userId, next)
    return next
  })
  const update = (patch: GuideState): void => {
    const next = { ...state, ...patch }
    setState(next)
    save(userId, next)
  }

  const oddsDone = state.odds === true || oddsSettled
  const steps = [bankrollSet, oddsDone, hasBets]
  if (!state.started || state.dismissed || steps.every(Boolean)) return null
  const doneCount = steps.filter(Boolean).length

  return (
    <section className="card first-run" aria-labelledby="first-run-title">
      <header className="first-run-head">
        <div>
          <h2 id="first-run-title">{t('guide.title')}</h2>
          <p className="hint">{t('guide.progress', { done: doneCount, total: steps.length })}</p>
        </div>
        <button type="button" className="btn-icon" aria-label={t('guide.hide')} title={t('guide.hide')} onClick={() => update({ dismissed: true })}>
          <CloseIcon />
        </button>
      </header>
      <ol className="first-run-steps">
        <li className={bankrollSet ? 'is-done' : ''}>
          <span className="step-mark" aria-hidden="true">
            {bankrollSet ? '✓' : '1'}
          </span>
          <div className="step-body">
            <strong>{t('guide.bankrollTitle')}</strong>
            <p className="hint">{t('guide.bankrollText')}</p>
            {!bankrollSet && (
              <button type="button" className="btn btn-ghost guide-bankroll" onClick={onSetBankroll}>
                {t('guide.bankrollGo')}
              </button>
            )}
          </div>
          <span className="visually-hidden">{bankrollSet ? t('guide.done') : t('guide.todo')}</span>
        </li>
        <li className={oddsDone ? 'is-done' : ''}>
          <span className="step-mark" aria-hidden="true">
            {oddsDone ? '✓' : '2'}
          </span>
          <div className="step-body">
            <strong>{t('guide.oddsTitle')}</strong>
            <p className="hint">{t('guide.oddsText')}</p>
            <div className="seg settings-seg guide-odds" role="group" aria-label={t('settings.oddsFormat')}>
              {ODDS_FORMATS.map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`seg-btn ${oddsFormat === f ? 'active' : ''}`}
                  aria-pressed={oddsFormat === f}
                  onClick={() => {
                    if (f !== oddsFormat) onPickOdds(f)
                    update({ odds: true })
                  }}
                >
                  <span>{t(`odds.${f}`)}</span>
                  <span className="seg-sample">{formatOdds(SAMPLE, f)}</span>
                </button>
              ))}
            </div>
          </div>
          <span className="visually-hidden">{oddsDone ? t('guide.done') : t('guide.todo')}</span>
        </li>
        <li className={hasBets ? 'is-done' : ''}>
          <span className="step-mark" aria-hidden="true">
            {hasBets ? '✓' : '3'}
          </span>
          <div className="step-body">
            <strong>{t('guide.betTitle')}</strong>
            <p className="hint">{t('guide.betText')}</p>
            {!hasBets && (
              <button type="button" className="btn btn-primary guide-bet" onClick={onAddBet}>
                {t('header.addBet')}
              </button>
            )}
          </div>
          <span className="visually-hidden">{hasBets ? t('guide.done') : t('guide.todo')}</span>
        </li>
      </ol>
    </section>
  )
}
