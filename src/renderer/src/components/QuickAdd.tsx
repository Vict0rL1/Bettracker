import { useEffect, useId, useRef, useState } from 'react'
import type { Bet, BetInput, BetStatus, Settings } from '../../../shared/types'
import type { QuickDraft } from '../data/drafts'
import { isFreeStake, moneyOf, oddsProblem, refusalText, resultProblem, stakeProblem, type Problem } from '../lib/betForm'
import { humanDate, todayStr } from '../lib/dates'
import { useLang } from '../lib/i18n'
import { ODDS_PLACEHOLDER, oddsInputMode, parseOdds } from '../lib/odds'
import { quickDefaults } from '../lib/quick'
import { round2, suggestedAmount } from '../lib/validate'
import { toneOf, type TagSuggestions } from './DayModal'
import FieldError, { describedBy } from './FieldError'
import { CloseIcon } from './icons'
import StakeNote from './StakeNote'

interface Props {
  bets: Bet[]
  settings: Settings
  suggestions: TagSuggestions
  /** The current bankroll, or null while it is unknown: the stake is measured against it. */
  bankroll: number | null
  /** Resolves once the bet is accepted; throws when it is refused, and the sheet stays open saying why. */
  onAdd: (input: BetInput) => Promise<void>
  /** An unfinished quick add to open with, or null. */
  draft: QuickDraft | null
  /** What is typed, kept as it changes (null: nothing worth keeping). */
  onDraft: (draft: QuickDraft | null) => void
  /** Carry what is typed over to the full form for today. */
  onMore: (draft: QuickDraft) => void
  onClose: () => void
}

const RESULTS: readonly BetStatus[] = ['won', 'lost', 'push', 'pending']

/** Why WON asks for the profit: no odds, a free bet (no cash staked), or a profit that rounds to $0.00. */
type ProfitWhy = 'noOdds' | 'freeBet' | 'roundsZero'

const sameDraft = (a: QuickDraft, b: QuickDraft): boolean =>
  a.stake === b.stake && a.odds === b.odds && a.sport === b.sport && a.book === b.book && a.betType === b.betType && a.profit === b.profit

/**
 * The fast path: stake, odds, tap a result. Everything else is prefilled —
 * tags from the last bet, stake from settings — so a pending bet on a phone
 * is two taps: the floating button, then PENDING. When a win's profit can't
 * be worked out (no odds, a free bet, a profit that rounds to $0.00), WON
 * asks for it instead of guessing.
 *
 * The sheet closes only once the bet is accepted. A problem is said next to
 * its box, and a refused bet above the buttons, with everything typed kept;
 * closing it by accident keeps that too (see data/drafts.ts).
 */
export default function QuickAdd({ bets, settings, suggestions, bankroll, onAdd, draft, onDraft, onMore, onClose }: Props) {
  const { t } = useLang()
  const defaults = quickDefaults(bets, settings)
  const blank: QuickDraft = {
    stake: defaults.stake === null ? '' : String(defaults.stake),
    odds: '',
    sport: defaults.sport,
    book: defaults.book,
    betType: defaults.betType,
    profit: ''
  }
  // The defaults as the sheet opened: what counts as nothing typed.
  const blankRef = useRef(blank)
  const start = draft ?? blank
  const [stakeStr, setStakeStr] = useState(start.stake)
  const [oddsStr, setOddsStr] = useState(start.odds)
  const [sport, setSport] = useState(start.sport)
  const [book, setBook] = useState(start.book)
  const [betType, setBetType] = useState(start.betType)
  const [profitStr, setProfitStr] = useState(start.profit)
  const [restored, setRestored] = useState(draft !== null)
  const [needProfit, setNeedProfit] = useState<ProfitWhy | null>(null)
  // Boxes whose problem is shown: once a result was tapped (not as a box is
  // left: a problem appearing then would move the buttons under the click).
  const [shown, setShown] = useState<ReadonlySet<'stake' | 'odds' | 'profit'>>(new Set())
  const [refusal, setRefusal] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const stakeRef = useRef<HTMLInputElement>(null)
  const oddsRef = useRef<HTMLInputElement>(null)
  const profitRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const listId = useId()
  const noteId = useId()
  const errId = useId()

  // Only as it opens: a new onClose from a re-render must not send the focus back to the stake.
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    // The stake is the one thing worth checking before a tap.
    stakeRef.current?.focus()
    stakeRef.current?.select()
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (needProfit) profitRef.current?.focus()
  }, [needProfit])

  const current: QuickDraft = { stake: stakeStr, odds: oddsStr, sport, book, betType, profit: profitStr }
  const onDraftRef = useRef(onDraft)
  onDraftRef.current = onDraft
  const draftText = JSON.stringify(current)
  useEffect(() => {
    const now = JSON.parse(draftText) as QuickDraft
    onDraftRef.current(sameDraft(now, blankRef.current) ? null : now)
  }, [draftText])

  const stake = moneyOf(stakeStr)
  const odds = parseOdds(oddsStr, settings.oddsFormat)
  const freeBet = isFreeStake(stake)
  const problems = {
    stake: stakeProblem(stakeStr),
    odds: oddsProblem(oddsStr, odds, settings.oddsFormat),
    profit: needProfit ? resultProblem(profitStr) : null
  }
  const showing = (field: 'stake' | 'odds' | 'profit'): Problem | null => (shown.has(field) ? problems[field] : null)
  const reveal = (...fields: ('stake' | 'odds' | 'profit')[]): void => setShown((s) => new Set([...s, ...fields]))

  /** Every problem shown, focus on the first: false when there is one. */
  const check = (fields: ('stake' | 'odds' | 'profit')[]): boolean => {
    reveal(...fields)
    const refs = { stake: stakeRef, odds: oddsRef, profit: profitRef }
    const first = fields.find((f) => problems[f] !== null)
    if (first) refs[first].current?.focus()
    return first === undefined
  }

  const log = async (status: BetStatus, amount: number | null): Promise<void> => {
    if (busy) return
    setBusy(true)
    setRefusal(null)
    try {
      await onAdd({ date: todayStr(), status, amount, stake, odds, sport, book, betType, note: '' })
      onDraft(null)
      onClose()
    } catch (err) {
      setRefusal(refusalText(err, t))
    } finally {
      setBusy(false)
    }
  }

  const tap = (status: BetStatus): void => {
    if (!check(['stake', 'odds'])) return
    const hint = suggestedAmount(status, stake, odds)
    if (status === 'won') {
      // The profit can't be worked out: ask for it instead of guessing.
      const why: ProfitWhy | null = freeBet ? 'freeBet' : hint === null ? 'noOdds' : hint === 0 ? 'roundsZero' : null
      if (why) {
        setNeedProfit(why)
        return
      }
    }
    // A free bet that loses costs nothing: its result is 0.
    void log(status, status === 'lost' && freeBet ? 0 : hint)
  }

  const saveWon = (): void => {
    if (!check(['stake', 'odds', 'profit'])) return
    void log('won', round2(moneyOf(profitStr) ?? 0))
  }

  const discard = (): void => {
    const b = blankRef.current
    setStakeStr(b.stake)
    setOddsStr(b.odds)
    setSport(b.sport)
    setBook(b.book)
    setBetType(b.betType)
    setProfitStr('')
    setNeedProfit(null)
    setShown(new Set())
    setRefusal(null)
    setRestored(false)
    onDraft(null)
    stakeRef.current?.focus()
  }

  const profitHint = needProfit === 'freeBet' ? t('quick.hintFreeBet') : needProfit === 'roundsZero' ? t('quick.hintRoundsZero') : t('quick.hintProfit')

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

        {restored && (
          <div className="draft-note" role="status">
            <span>{t('draft.restored')}</span>
            <button type="button" className="auth-toggle draft-discard" onClick={discard}>
              {t('draft.discard')}
            </button>
          </div>
        )}

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
                aria-invalid={showing('stake') !== null}
                aria-describedby={describedBy(showing('stake') && `${errId}-stake`, noteId)}
                onChange={(e) => setStakeStr(e.target.value)}
              />
            </div>
            <FieldError id={`${errId}-stake`} problem={showing('stake')} />
          </label>
          <label className="field">
            <span className="field-label">
              {t('quick.odds')} <span className="field-opt">{t('common.optional')}</span>
            </span>
            <input
              ref={oddsRef}
              type="text"
              inputMode={oddsInputMode(settings.oddsFormat)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder={ODDS_PLACEHOLDER[settings.oddsFormat]}
              value={oddsStr}
              aria-invalid={showing('odds') !== null}
              aria-describedby={describedBy(showing('odds') && `${errId}-odds`)}
              onChange={(e) => setOddsStr(e.target.value)}
            />
            <FieldError id={`${errId}-odds`} problem={showing('odds')} />
          </label>
        </div>

        {/* Quick add is always today, so the share of the bankroll always applies. */}
        {freeBet ? (
          <p className="stake-note free-bet-note" id={noteId}>
            {t('quick.freeBetNote')}
          </p>
        ) : (
          <StakeNote id={noteId} stake={problems.stake === null ? stake : null} current={bankroll} applies />
        )}

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
              <span className="field-label">{needProfit === 'freeBet' ? t('quick.promoProfit') : t('modal.profit')}</span>
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
                  aria-invalid={showing('profit') !== null}
                  aria-describedby={describedBy(showing('profit') && `${errId}-profit`, `${errId}-why`)}
                  onChange={(e) => setProfitStr(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveWon()
                  }}
                />
              </div>
              <FieldError id={`${errId}-profit`} problem={showing('profit')} />
            </label>
            <button type="button" className="btn btn-primary quick-save" disabled={busy} onClick={saveWon}>
              {t('quick.saveWon')}
            </button>
            <button
              type="button"
              className="auth-toggle"
              onClick={() => {
                setNeedProfit(null)
                setRefusal(null)
              }}
            >
              {t('quick.backToResults')}
            </button>
          </div>
        ) : (
          <div className="seg quick-results" role="group" aria-label={t('modal.resultGroup')}>
            {RESULTS.map((s) => (
              <button key={s} type="button" className={`seg-btn ${toneOf(s)}`} disabled={busy} onClick={() => tap(s)}>
                {t(`status.${s}`)}
              </button>
            ))}
          </div>
        )}

        {refusal && (
          <p className="form-error" role="alert">
            {refusal}
          </p>
        )}

        <p className="hint" id={`${errId}-why`}>
          {needProfit ? profitHint : t('quick.hint')}
        </p>
        <button type="button" className="auth-toggle quick-more" onClick={() => onMore(current)}>
          {t('quick.more')}
        </button>
      </div>
    </div>
  )
}
