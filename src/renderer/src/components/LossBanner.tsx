import { fmtPct, fmtStake } from '../lib/format'
import { useLang } from '../lib/i18n'
import type { LossState } from '../lib/lossLimit'
import { CloseIcon } from './icons'

interface Props {
  state: LossState
  onChangeLimit: () => void
  onDismiss: () => void
}

/**
 * The monthly loss warning. Amber at 80% of the limit, red past it; a
 * dismissal hides it until the next line is crossed or the month turns. It
 * never stands between the user and logging a bet.
 */
export default function LossBanner({ state, onChangeLimit, onDismiss }: Props) {
  const { t } = useLang()
  if (state.level === 'none' || state.limit === null) return null
  const vars = { loss: fmtStake(state.loss), limit: fmtStake(state.limit), pct: fmtPct(state.ratio * 100) }
  return (
    <div className={`loss-banner ${state.level}`} role={state.level === 'over' ? 'alert' : 'status'}>
      <span className="loss-text">{state.level === 'over' ? t('loss.over', vars) : t('loss.near', vars)}</span>
      <button type="button" className="auth-toggle loss-change" onClick={onChangeLimit}>
        {t('loss.change')}
      </button>
      <button type="button" className="btn-icon loss-dismiss" aria-label={t('loss.dismiss')} title={t('loss.dismiss')} onClick={onDismiss}>
        <CloseIcon size={14} />
      </button>
    </div>
  )
}
