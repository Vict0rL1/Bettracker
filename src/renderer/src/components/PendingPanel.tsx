import { useEffect, useId } from 'react'
import type { Bet, BetStatus, OddsFormat } from '../../../shared/types'
import { humanDate } from '../lib/dates'
import { fmtStake } from '../lib/format'
import { useLang } from '../lib/i18n'
import { formatOdds } from '../lib/odds'
import type { OpenBet } from '../lib/pending'
import { suggestedAmount } from '../lib/validate'
import { toneOf } from './DayModal'
import { CloseIcon, PencilIcon } from './icons'

interface Props {
  open: OpenBet[]
  oddsFormat: OddsFormat
  /** Settle with the result the stake and odds imply, or open the day when they can't. */
  onSettle: (bet: Bet, status: BetStatus, amount: number | null) => void
  onOpenDay: (date: string) => void
  onClose: () => void
}

const SETTLE: readonly BetStatus[] = ['won', 'lost', 'push', 'void']

/**
 * Every bet still waiting for a result, oldest first, each settled in one tap.
 * A bet whose date has passed is flagged: that is the one the user forgot.
 */
export default function PendingPanel({ open, oddsFormat, onSettle, onOpenDay, onClose }: Props) {
  const { t, tn } = useLang()
  const titleId = useId()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const riding = open.reduce((sum, o) => sum + (o.bet.stake ?? 0), 0)
  const pastCount = open.filter((o) => o.past).length
  const sub =
    open.length === 0
      ? t('pend.none')
      : t('pend.sub', { bets: tn('bet', open.length), amount: fmtStake(riding) }) + (pastCount > 0 ? t('pend.pastSuffix', { n: pastCount }) : '')

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal card pending-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal-head">
          <div>
            <h2 id={titleId}>{t('pend.title')}</h2>
            <span className="day-sub">{sub}</span>
          </div>
          <button type="button" className="btn-icon" aria-label={t('common.close')} onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        {open.length === 0 ? (
          <div className="empty-state pend-empty">{t('pend.empty')}</div>
        ) : (
          <ul className="bet-list pend-list">
            {open.map(({ bet: b, past }) => {
              const tags = [b.sport, b.book, b.betType].filter(Boolean)
              return (
                <li key={b.id} className={`bet-item pend-item ${past ? 'is-past' : ''}`}>
                  <span className="pend-date">
                    {humanDate(b.date)}
                    {past && (
                      <span className="pend-past" title={t('pend.pastTitle')}>
                        {t('pend.past')}
                      </span>
                    )}
                  </span>
                  <span className="bet-body">
                    <span className="bet-note">{b.note || <span className="td-none">{t('modal.noNote')}</span>}</span>
                    <span className="bet-meta">
                      {b.stake !== null && (
                        <span className="bet-stake">
                          {t('modal.riding', { amount: fmtStake(b.stake) })}
                          {b.odds !== null && ` @ ${formatOdds(b.odds, oddsFormat)}`}
                        </span>
                      )}
                      {tags.map((x) => (
                        <span key={x} className="tag">
                          {x}
                        </span>
                      ))}
                    </span>
                    <span className="settle" role="group" aria-label={t('hist.settleAria', { date: b.date })}>
                      {SETTLE.map((s) => (
                        <button
                          key={s}
                          type="button"
                          className={`settle-btn ${toneOf(s)}`}
                          title={t('hist.markAs', { status: t(`statusWord.${s}`) })}
                          onClick={() => onSettle(b, s, suggestedAmount(s, b.stake, b.odds))}
                        >
                          {t(`status.${s}`)}
                        </button>
                      ))}
                    </span>
                  </span>
                  <span className="bet-actions">
                    <button type="button" className="btn-icon" aria-label={t('hist.editAria', { date: b.date })} title={t('hist.editDay')} onClick={() => onOpenDay(b.date)}>
                      <PencilIcon />
                    </button>
                  </span>
                </li>
              )
            })}
          </ul>
        )}

        <footer className="modal-actions">
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.done')}
          </button>
        </footer>
      </div>
    </div>
  )
}
