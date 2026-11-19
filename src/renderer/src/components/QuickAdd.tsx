import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Bet, BetInput, BetStatus, Settings } from '../../../shared/types'
import type { QuickDraft } from '../data/drafts'
import { isFreeStake, moneyOf, oddsProblem, refusalText, resultProblem, stakeProblem, type Problem } from '../lib/betForm'
import {
  CASINO_GAMES,
  CASINO_SPORT,
  canonicalGame,
  casinoAmountProblem,
  casinoInput,
  casinoValues,
  wageredProblem,
  type CasinoFields,
  type QuickKind
} from '../lib/casino'
import { addDays, humanDate, todayStr } from '../lib/dates'
import { useLang } from '../lib/i18n'
import { ODDS_PLACEHOLDER, oddsInputMode, parseOdds } from '../lib/odds'
import { casinoDefaults, quickDefaults, quickKind } from '../lib/quick'
import { isValidDate, round2, suggestedAmount } from '../lib/validate'
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
  /** Carry what is typed over to the full form for its date. */
  onMore: (draft: QuickDraft & { date: string }) => void
  onClose: () => void
}

const RESULTS: readonly BetStatus[] = ['won', 'lost', 'push', 'pending']
const KINDS: readonly QuickKind[] = ['sports', 'casino']
const CASINO_RESULTS = ['won', 'lost'] as const
type CasinoResult = (typeof CASINO_RESULTS)[number]

/** Why WON asks for the profit: no odds, a free bet (no cash staked), or a profit that rounds to $0.00. */
type ProfitWhy = 'noOdds' | 'freeBet' | 'roundsZero'

const sameCasino = (a: CasinoFields | undefined, b: CasinoFields | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.game === b.game && a.amount === b.amount && a.site === b.site && a.wagered === b.wagered)

/** Nothing typed on either side: which side is open is no draft on its own. */
const sameDraft = (a: QuickDraft, b: QuickDraft): boolean =>
  a.date === b.date &&
  a.stake === b.stake &&
  a.odds === b.odds &&
  a.sport === b.sport &&
  a.book === b.book &&
  a.betType === b.betType &&
  a.profit === b.profit &&
  sameCasino(a.casino, b.casino)

/** A game as the chips and the free box show it: one of the chips, or typed. */
const gameBoxes = (game: string): { chip: string; other: string } => {
  const g = canonicalGame(game)
  return (CASINO_GAMES as readonly string[]).includes(g) ? { chip: g, other: '' } : { chip: '', other: game }
}

type Field = 'date' | 'stake' | 'odds' | 'profit' | 'amount' | 'wagered'

/**
 * The fast path: stake, odds, tap a result. Everything else is prefilled —
 * tags from the last bet, stake from settings — so a pending bet on a phone
 * is two taps: the floating button, then PENDING. When a win's profit can't
 * be worked out (no odds, a free bet, a profit that rounds to $0.00), WON
 * asks for it instead of guessing.
 *
 * Sports | Casino at the top switches to a casino play (lib/casino.ts): a
 * game, what it won or lost, and Won or Lost. The sheet opens on the kind of
 * the bet logged last, or on the side its draft was typed on.
 *
 * The sheet closes only once the bet is accepted. A problem is said next to
 * its box, and a refused bet above the buttons, with everything typed kept;
 * closing it by accident keeps that too (see data/drafts.ts).
 */
export default function QuickAdd({ bets, settings, suggestions, bankroll, onAdd, draft, onDraft, onMore, onClose }: Props) {
  const { t } = useLang()
  const defaults = quickDefaults(bets, settings)
  const casinoStart = casinoDefaults(bets)
  // Today as the sheet opened, on this device's clock: the default date, and
  // what the shortcuts mean while it is open (a sheet left open past
  // midnight keeps the day it showed).
  const [today] = useState(todayStr)
  const blankCasino: CasinoFields = { game: casinoStart.game, amount: '', site: casinoStart.site, wagered: '' }
  const blank: QuickDraft = {
    date: today,
    stake: defaults.stake === null ? '' : String(defaults.stake),
    odds: '',
    sport: defaults.sport,
    book: defaults.book,
    betType: defaults.betType,
    profit: '',
    casino: blankCasino
  }
  // The defaults as the sheet opened: what counts as nothing typed.
  const blankRef = useRef(blank)
  const start = draft ?? blank
  // A draft from before casino plays has no casino side: the defaults.
  const startCasino = start.casino ?? blankCasino
  const [kind, setKind] = useState<QuickKind>(() => (draft ? (draft.kind ?? 'sports') : quickKind(bets)))
  const [date, setDate] = useState(start.date || today)
  const [stakeStr, setStakeStr] = useState(start.stake)
  const [oddsStr, setOddsStr] = useState(start.odds)
  const [sport, setSport] = useState(start.sport)
  const [book, setBook] = useState(start.book)
  const [betType, setBetType] = useState(start.betType)
  const [profitStr, setProfitStr] = useState(start.profit)
  const [gameChip, setGameChip] = useState(() => gameBoxes(startCasino.game).chip)
  const [gameOther, setGameOther] = useState(() => gameBoxes(startCasino.game).other)
  const [amountStr, setAmountStr] = useState(startCasino.amount)
  const [site, setSite] = useState(startCasino.site)
  const [wageredStr, setWageredStr] = useState(startCasino.wagered)
  // The casino result tapped last: a loss is checked against what was wagered.
  const [tried, setTried] = useState<CasinoResult | null>(null)
  const [restored, setRestored] = useState(draft !== null)
  const [needProfit, setNeedProfit] = useState<ProfitWhy | null>(null)
  // Boxes whose problem is shown: once a result was tapped (not as a box is
  // left: a problem appearing then would move the buttons under the click).
  const [shown, setShown] = useState<ReadonlySet<Field>>(new Set())
  const [refusal, setRefusal] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dateRef = useRef<HTMLInputElement>(null)
  const stakeRef = useRef<HTMLInputElement>(null)
  const oddsRef = useRef<HTMLInputElement>(null)
  const profitRef = useRef<HTMLInputElement>(null)
  const amountRef = useRef<HTMLInputElement>(null)
  const wageredRef = useRef<HTMLInputElement>(null)
  const kindRefs = useRef(new Map<QuickKind, HTMLButtonElement>())
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
    // The stake is the one thing worth checking before a tap; on a casino play, what it won or lost.
    const first = kind === 'casino' ? amountRef.current : stakeRef.current
    first?.focus()
    first?.select()
    return () => window.removeEventListener('keydown', onKey)
    // Only as it opens.
  }, [])

  useEffect(() => {
    if (needProfit) profitRef.current?.focus()
  }, [needProfit])

  const game = gameOther.trim() !== '' ? gameOther : gameChip
  const casino: CasinoFields = { game, amount: amountStr, site, wagered: wageredStr }
  const current: QuickDraft & { date: string } = { date, stake: stakeStr, odds: oddsStr, sport, book, betType, profit: profitStr, kind, casino }
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
  /** Every box's problem; a casino play's amount as for the result tapped (a loss can't top the wager). */
  const problemsFor = (result: CasinoResult | null): Record<Field, Problem | null> => ({
    date: isValidDate(date) ? null : { key: 'field.dateInvalid' },
    stake: stakeProblem(stakeStr),
    odds: oddsProblem(oddsStr, odds, settings.oddsFormat),
    profit: needProfit ? resultProblem(profitStr) : null,
    amount: casinoAmountProblem(casino, result),
    wagered: wageredProblem(wageredStr)
  })
  const problems = problemsFor(tried)
  const showing = (field: Field): Problem | null => (shown.has(field) ? problems[field] : null)
  const reveal = (...fields: Field[]): void => setShown((s) => new Set([...s, ...fields]))

  /** Every problem shown, focus on the first: false when there is one. */
  const check = (fields: Field[], found: Record<Field, Problem | null> = problems): boolean => {
    reveal(...fields)
    const refs = { date: dateRef, stake: stakeRef, odds: oddsRef, profit: profitRef, amount: amountRef, wagered: wageredRef }
    const first = fields.find((f) => found[f] !== null)
    if (first) refs[first].current?.focus()
    return first === undefined
  }

  const save = async (input: BetInput): Promise<void> => {
    if (busy) return
    setBusy(true)
    setRefusal(null)
    try {
      await onAdd(input)
      onDraft(null)
      onClose()
    } catch (err) {
      setRefusal(refusalText(err, t))
    } finally {
      setBusy(false)
    }
  }

  // The day shown, chosen or not: never the clock's at the time of the tap.
  const log = (status: BetStatus, amount: number | null): Promise<void> => save({ date, status, amount, stake, odds, sport, book, betType, note: '' })

  const tap = (status: BetStatus): void => {
    if (!check(['date', 'stake', 'odds'])) return
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
    if (!check(['date', 'stake', 'odds', 'profit'])) return
    void log('won', round2(moneyOf(profitStr) ?? 0))
  }

  /** Won or Lost on the casino side: what it won or lost, signed by the button. */
  const tapCasino = (result: CasinoResult): void => {
    setTried(result)
    if (!check(['date', 'amount', 'wagered'], problemsFor(result))) return
    void save(casinoInput(date, casino, result))
  }

  const pickKind = (next: QuickKind): void => {
    if (next === kind) return
    setKind(next)
    setRefusal(null)
  }

  /** The two sides are a radio group: the arrows, Home and End move and choose. */
  const onKindKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const at = KINDS.indexOf(kind)
    let to: number | null = null
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = (at - 1 + KINDS.length) % KINDS.length
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = (at + 1) % KINDS.length
    else if (e.key === 'Home') to = 0
    else if (e.key === 'End') to = KINDS.length - 1
    if (to === null) return
    e.preventDefault()
    pickKind(KINDS[to])
    kindRefs.current.get(KINDS[to])?.focus()
  }

  const pickGame = (g: string): void => {
    // The chosen chip, tapped again, lets it go: no game.
    setGameChip(gameChip === g && gameOther.trim() === '' ? '' : g)
    setGameOther('')
  }

  const discard = (): void => {
    const b = blankRef.current
    const c = b.casino ?? blankCasino
    setDate(b.date ?? today)
    setStakeStr(b.stake)
    setOddsStr(b.odds)
    setSport(b.sport)
    setBook(b.book)
    setBetType(b.betType)
    setProfitStr('')
    setNeedProfit(null)
    setGameChip(gameBoxes(c.game).chip)
    setGameOther(gameBoxes(c.game).other)
    setAmountStr(c.amount)
    setSite(c.site)
    setWageredStr(c.wagered)
    setTried(null)
    setShown(new Set())
    setRefusal(null)
    setRestored(false)
    onDraft(null)
    ;(kind === 'casino' ? amountRef : stakeRef).current?.focus()
  }

  /** The full form for the day: a casino play goes as the bet it would be (sport Casino, the game as its type). */
  const more = (): void => {
    const day = isValidDate(date) ? date : today
    if (kind === 'sports') onMore({ ...current, date: day })
    else onMore({ date: day, stake: wageredStr, odds: '', sport: CASINO_SPORT, book: site, betType: canonicalGame(game), profit: amountStr })
  }

  const games = useMemo(() => casinoValues(bets, 'betType'), [bets])
  const sites = useMemo(() => casinoValues(bets, 'book'), [bets])

  const yesterday = addDays(today, -1)
  const profitHint = needProfit === 'freeBet' ? t('quick.hintFreeBet') : needProfit === 'roundsZero' ? t('quick.hintRoundsZero') : t('quick.hintProfit')
  const hintText = kind === 'casino' ? t('casino.hint') : needProfit ? profitHint : t('quick.hint')

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className={`modal card quick-modal is-${kind}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal-head">
          <div>
            <h2 id={titleId}>{t('quick.title')}</h2>
            <span className="day-sub quick-for" aria-live="polite">
              {!isValidDate(date)
                ? ''
                : date === today
                  ? t('quick.forDateRel', { date: humanDate(date), rel: t('quick.relToday') })
                  : date === yesterday
                    ? t('quick.forDateRel', { date: humanDate(date), rel: t('quick.relYesterday') })
                    : t('quick.forDate', { date: humanDate(date) })}
            </span>
          </div>
          <button type="button" className="btn-icon" aria-label={t('common.close')} onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        <div className="scope-toggle quick-kind" role="radiogroup" aria-label={t('quick.kindGroup')} onKeyDown={onKindKey}>
          {KINDS.map((k) => (
            <button
              key={k}
              ref={(el) => {
                if (el) kindRefs.current.set(k, el)
                else kindRefs.current.delete(k)
              }}
              type="button"
              role="radio"
              aria-checked={kind === k}
              tabIndex={kind === k ? 0 : -1}
              className={`scope-btn quick-kind-btn quick-kind-${k}${kind === k ? ' active' : ''}`}
              onClick={() => pickKind(k)}
            >
              {t(k === 'sports' ? 'quick.kindSports' : 'quick.kindCasino')}
            </button>
          ))}
        </div>

        {restored && (
          <div className="draft-note" role="status">
            <span>{t('draft.restored')}</span>
            <button type="button" className="auth-toggle draft-discard" onClick={discard}>
              {t('draft.discard')}
            </button>
          </div>
        )}

        <div className="quick-date">
          <div className="quick-date-row">
            {/* Not a `.field`: the stake stays the sheet's first box, as it is the first to check. */}
            <label className="quick-date-field">
              <span className="field-label">{t('quick.date')}</span>
              <input
                ref={dateRef}
                type="date"
                className="quick-date-input"
                value={date}
                required
                aria-invalid={showing('date') !== null}
                aria-describedby={describedBy(showing('date') && `${errId}-date`)}
                onChange={(e) => {
                  setDate(e.target.value)
                  if (e.target.value === '') reveal('date')
                }}
              />
            </label>
            <div className="quick-date-chips" role="group" aria-label={t('quick.dateShortcuts')}>
              <button type="button" className={`chip quick-today ${date === today ? 'active' : ''}`} aria-pressed={date === today} onClick={() => setDate(today)}>
                {t('quick.today')}
              </button>
              <button type="button" className={`chip quick-yesterday ${date === yesterday ? 'active' : ''}`} aria-pressed={date === yesterday} onClick={() => setDate(yesterday)}>
                {t('quick.yesterday')}
              </button>
            </div>
          </div>
          <FieldError id={`${errId}-date`} problem={showing('date')} />
        </div>

        {kind === 'casino' ? (
          <>
            <div className="field quick-game">
              <span className="field-label" id={`${errId}-game`}>
                {t('casino.game')}
              </span>
              <div className="quick-games" role="group" aria-labelledby={`${errId}-game`}>
                {CASINO_GAMES.map((g) => {
                  const on = gameChip === g && gameOther.trim() === ''
                  return (
                    <button key={g} type="button" className={`chip quick-game-chip${on ? ' active' : ''}`} aria-pressed={on} onClick={() => pickGame(g)}>
                      {g}
                    </button>
                  )
                })}
              </div>
              <input
                type="text"
                className="quick-game-other"
                list={`${listId}-game`}
                maxLength={40}
                autoComplete="off"
                placeholder={t('casino.otherGame')}
                aria-label={t('casino.otherGame')}
                value={gameOther}
                onChange={(e) => {
                  setGameOther(e.target.value)
                  setGameChip('')
                }}
              />
              <datalist id={`${listId}-game`}>
                {games.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            </div>

            <label className="field quick-casino-amount">
              <span className="field-label">{t('casino.amount')}</span>
              <div className="amount-wrap">
                <span className="amount-cur">$</span>
                <input
                  ref={amountRef}
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  step="0.01"
                  placeholder="0.00"
                  value={amountStr}
                  aria-invalid={showing('amount') !== null}
                  aria-describedby={describedBy(showing('amount') && `${errId}-amount`, `${errId}-why`)}
                  onChange={(e) => setAmountStr(e.target.value)}
                />
              </div>
              <FieldError id={`${errId}-amount`} problem={showing('amount')} />
            </label>

            <div className="quick-casino-more">
              <label className="field quick-site">
                <span className="field-label">{t('casino.site')}</span>
                <input type="text" list={`${listId}-site`} maxLength={40} autoComplete="off" value={site} onChange={(e) => setSite(e.target.value)} />
              </label>
              <label className="field quick-wagered">
                <span className="field-label">
                  {t('casino.wagered')} <span className="field-opt">{t('common.optional')}</span>
                </span>
                <div className="amount-wrap">
                  <span className="amount-cur">$</span>
                  <input
                    ref={wageredRef}
                    type="number"
                    inputMode="decimal"
                    min="0.01"
                    step="0.01"
                    placeholder="0.00"
                    value={wageredStr}
                    aria-invalid={showing('wagered') !== null}
                    aria-describedby={describedBy(showing('wagered') && `${errId}-wagered`)}
                    onChange={(e) => setWageredStr(e.target.value)}
                  />
                </div>
                <FieldError id={`${errId}-wagered`} problem={showing('wagered')} />
              </label>
              <datalist id={`${listId}-site`}>
                {sites.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            </div>

            <div className="seg quick-casino-results" role="group" aria-label={t('modal.resultGroup')}>
              {CASINO_RESULTS.map((r) => (
                <button key={r} type="button" className={`seg-btn quick-casino-${r}`} disabled={busy} onClick={() => tapCasino(r)}>
                  {t(r === 'won' ? 'casino.won' : 'casino.lost')}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
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

            {/* The share of the bankroll applies to a bet from today on (the full form's rule). */}
            {freeBet ? (
              <p className="stake-note free-bet-note" id={noteId}>
                {t('quick.freeBetNote')}
              </p>
            ) : (
              <StakeNote id={noteId} stake={problems.stake === null ? stake : null} current={bankroll} applies={date >= today} />
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
          </>
        )}

        {refusal && (
          <p className="form-error" role="alert">
            {refusal}
          </p>
        )}

        <p className="hint" id={`${errId}-why`}>
          {hintText}
        </p>
        <button type="button" className="auth-toggle quick-more" onClick={more}>
          {kind === 'casino' ? t('quick.moreCasino') : t('quick.more')}
        </button>
      </div>
    </div>
  )
}
