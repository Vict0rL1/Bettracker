import { stakeNote } from '../lib/bankroll'
import { fmtPct1 } from '../lib/format'
import { useLang } from '../lib/i18n'
import { useMoney } from '../lib/money'

interface Props {
  /** Referenced by the stake box's aria-describedby. */
  id: string
  /** The stake as typed, or null while the box is empty or invalid. */
  stake: number | null
  /** The bankroll to measure against; null while it is unknown (loading or never set up). */
  current: number | null
  /** False for a bet whose stake is history (settled, on a past date): only the units echo shows. */
  applies: boolean
}

/**
 * One quiet line under a stake box: the stake in units when units are on, and
 * what share of the bankroll it is, in amber above 5%. It never blocks, never
 * asks, and never changes what is saved.
 *
 * The line is always there, empty when there is nothing to say, so the
 * result buttons below it don't move under the thumb when it fills in. A
 * screen reader hears it through the stake box's description, and only the
 * crossing into "over 5%" is announced, not every keystroke.
 */
export default function StakeNote({ id, stake, current, applies }: Props) {
  const { t } = useLang()
  const money = useMoney()
  const note = applies ? stakeNote(stake, current) : ({ kind: 'none' } as const)

  const echo = money.unit !== null && stake !== null && stake > 0 ? money.stake(stake) : ''
  const body =
    note.kind === 'bankroll'
      ? t('stake.bankroll', { amount: money.bankroll(note.current) })
      : note.kind === 'share' || note.kind === 'over'
        ? t(`stake.${note.kind}`, { pct: fmtPct1(note.pct), amount: money.bankroll(note.current) })
        : note.kind === 'empty'
          ? t('stake.empty', { amount: money.bankroll(note.current) })
          : ''
  // A warning leads, so a narrow screen cuts the units echo, not the warning.
  const warn = note.kind === 'over' || note.kind === 'empty'
  const text = (warn ? [body, echo] : [echo, body]).filter(Boolean).join(' · ')

  return (
    <>
      <p id={id} className={`stake-note ${warn ? 'over' : ''}`} title={text || undefined}>
        {text}
      </p>
      <span className="visually-hidden" aria-live="polite">
        {note.kind === 'over' ? t('stake.overLive') : ''}
      </span>
    </>
  )
}
