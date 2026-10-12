import { useEffect, useId, useRef, useState } from 'react'
import type { Bet, BetInput, BetStatus, Settings } from '../../../shared/types'
import { humanDate, todayStr } from '../lib/dates'
import { useLang } from '../lib/i18n'
import { ODDS_PLACEHOLDER, parseOdds } from '../lib/odds'
import { quickDefaults } from '../lib/quick'
import { MAX_AMOUNT, round2, storableOdds, suggestedAmount } from '../lib/validate'
import { toneOf, type TagSuggestions } from './DayModal'
import { CloseIcon } from './icons'

interface Props {
  bets: Bet[]
  settings: Settings
  suggestions: TagSuggestions
  onAdd: (input: BetInput) => Promise<void>
  onClose: () => void
}

const RESULTS: readonly BetStatus[] = ['won', 'lost', 'push', 'pending']

/**
 * The fast path: stake, odds, tap a result. Everything else is prefilled —
 * tags from the last bet, stake from settings — so a pending bet on a phone
 * is two taps: the floating button, then PENDING. A win with no odds has no
 * computable profit, so WON then reveals a profit box and a save button.
 */
export default function QuickAdd({ bets, settings, suggestions, onAdd, onClose }: Props) {
  const { t } = useLang()
  const defaults = quickDefaults(bets, settings)
  const [stakeStr, setStakeStr] = useState(defaults.stake === null ? '' : String(defaults.stake))
  const [oddsStr, setOddsStr] = useState('')
  const [sport, setSport] = useState(defaults.sport)
  const [book, setBook] = useState(defaults.book)
  const [betType, setBetType] = useState(defaults.betType)
  const [profitStr, setProfitStr] = useState('')
  const [needProfit, setNeedProfit] = useState(false)
  const [busy, setBusy] = useState(false)
  const stakeRef = useRef<HTMLInputElement>(null)
  const profitRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const listId = useId()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    // The stake is the one thing worth checking before a tap.
    stakeRef.current?.focus()
    stakeRef.current?.select()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (needProfit) profitRef.current?.focus()
  }, [needProfit])

  const stake = stakeStr.trim() === '' ? null : parseFloat(stakeStr)
  const stakeValid = stake !== null && Number.isFinite(stake) && stake >= 0 && stake <= MAX_AMOUNT
  const odds = parseOdds(oddsStr, settings.oddsFormat)
  const oddsValid = oddsStr.trim() === '' || (odds !== null && storableOdds(odds))
  const profit = parseFloat(profitStr)
  const profitValid = Number.isFinite(profit) && profit > 0 && profit <= MAX_AMOUNT

  const log = async (status: BetStatus, amount: number | null): Promise<void> => {
    if (!stakeValid || !oddsValid || busy) return
    setBusy(true)
    try {
      await onAdd({ date: todayStr(), status, amount, stake, odds, sport, book, betType, note: '' })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const tap = (status: BetStatus): void => {
    const hint = suggestedAmount(status, stake, odds)
    if (status === 'won' && hint === null) {
      // No odds: ask for the profit instead of guessing.
      setNeedProfit(true)
      return
    }
    void log(status, hint)
  }

  const ready = stakeValid && oddsValid && !busy

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal card quick-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal-head">
          <div>
            <h2 id={titleId}>{t('quick.title')}</h2>
            <span className="day-sub">{t('quick.forDate', { date: humanDate(todayStr()) })}</span>
          </div>
          <button type="button" className="btn-icon" aria-label={t('common.close')} onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        <div className="quick-row">
          <label className="field">
            <span className="field-label">{t('quick.stake')}</span>
            <div className="amount-wrap">
              <span className="amount-cur">$</span>
              <input
                ref={stakeRef}
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={stakeStr}
                onChange={(e) => setStakeStr(e.target.value)}
              />
            </div>
          </label>
          <label className="field">
            <span className="field-label">
              {t('quick.odds')} <span className="field-opt">{t('common.optional')}</span>
            </span>
            <input
              type="text"
              inputMode="decimal"
              placeholder={ODDS_PLACEHOLDER[settings.oddsFormat]}
              value={oddsStr}
              aria-invalid={!oddsValid}
              onChange={(e) => setOddsStr(e.target.value)}
            />
          </label>
        </div>

        <div className="quick-tags">
          <input type="text" list={`${listId}-sport`} maxLength={40} placeholder={t('modal.sport')} aria-label={t('modal.sport')} value={sport} onChange={(e) => setSport(e.target.value)} />
          <input type="text" list={`${listId}-book`} maxLength={40} placeholder={t('modal.book')} aria-label={t('modal.book')} value={book} onChange={(e) => setBook(e.target.value)} />
          <input type="text" list={`${listId}-type`} maxLength={40} placeholder={t('modal.betType')} aria-label={t('modal.betType')} value={betType} onChange={(e) => setBetType(e.target.value)} />
        </div>
        <datalist id={`${listId}-sport`}>
          {suggestions.sport.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
        <datalist id={`${listId}-book`}>
          {suggestions.book.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
        <datalist id={`${listId}-type`}>
          {suggestions.betType.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>

        {needProfit ? (
          <div className="quick-row quick-profit">
            <label className="field">
              <span className="field-label">{t('modal.profit')}</span>
              <div className="amount-wrap">
                <span className="amount-cur">$</span>
                <input
                  ref={profitRef}
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  step="0.01"
                  placeholder="0.00"
                  value={profitStr}
                  onChange={(e) => setProfitStr(e.target.value)}
                />
              </div>
            </label>
            <button type="button" className="btn btn-primary quick-save" disabled={!ready || !profitValid} onClick={() => void log('won', round2(profit))}>
              {t('quick.saveWon')}
            </button>
            <button type="button" className="auth-toggle" onClick={() => setNeedProfit(false)}>
              {t('modal.cancelEdit')}
            </button>
          </div>
        ) : (
          <div className="seg quick-results" role="group" aria-label={t('modal.resultGroup')}>
            {RESULTS.map((s) => (
              <button key={s} type="button" className={`seg-btn ${toneOf(s)}`} disabled={!ready} onClick={() => tap(s)}>
                {t(`status.${s}`)}
              </button>
            ))}
          </div>
        )}

        <p className="hint">{needProfit ? t('quick.hintProfit') : t('quick.hint')}</p>
      </div>
    </div>
  )
}
