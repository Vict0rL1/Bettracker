import type { ExpenseCategory } from '../../../../shared/types'
import { categoryKey } from '../../lib/categories'
import { fmtPct } from '../../lib/format'
import { useLang } from '../../lib/i18n'
import { useMoney } from '../../lib/money'
import type { CategoryShare } from '../../lib/spend'

interface Props {
  shares: CategoryShare[]
  /** The list's category filter: its row reads as pressed. */
  active: ExpenseCategory | 'all'
  /** A row narrows the list below to its category; pressed again, it lets go. */
  onPick: (c: ExpenseCategory | 'all') => void
}

/** Where the month's money went, largest first; each row filters the list. */
export default function CategoryBreakdown({ shares, active, onPick }: Props) {
  const { t } = useLang()
  const money = useMoney()

  return (
    <article className="card spend-cats-card">
      <header className="card-head">
        <h2>{t('spend.catTitle')}</h2>
      </header>
      {shares.length === 0 ? (
        <p className="empty-state">{t('spend.catNone')}</p>
      ) : (
        <ul className="spend-cat-list">
          {shares.map((s) => {
            const pressed = active === s.category
            return (
              <li key={s.category} className="spend-cat-row" data-cat={s.category}>
                <button type="button" className="spend-cat-btn" aria-pressed={pressed} onClick={() => onPick(pressed ? 'all' : s.category)}>
                  <span className="spend-cat-main">
                    <span className="spend-cat-name">{t(categoryKey(s.category))}</span>
                    <span className={`spend-cat-amount${s.amount < 0 ? ' refund' : ''}`}>{money.plain(s.amount)}</span>
                  </span>
                  <span className="bd-bar" aria-hidden="true">
                    <span className="bd-fill ink" style={{ width: `${s.share * 100}%` }} />
                  </span>
                  <span className="spend-cat-share">{t('spend.share', { pct: fmtPct(s.share * 100) })}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </article>
  )
}
