import type { ExpenseCategory } from '../../../../shared/types'
import { categoryKey } from '../../lib/categories'
import { fmtPct } from '../../lib/format'
import { useLang } from '../../lib/i18n'
import { useMoney } from '../../lib/money'
import type { CategoryShare, Drill } from '../../lib/spend'
import CategoryIcon from './CategoryIcon'

interface Props {
  shares: CategoryShare[]
  /** Whether the expenses have loaded on this device: until then a dash, never "nothing to break down" (the summary says why). */
  loaded: boolean
  /** The list's category filter: its line reads as the one the list shows. */
  active: ExpenseCategory | 'all'
  /** A line shows that category's expenses in the list below (ExpensesView), whatever the list showed before. */
  onShow: (d: Drill) => void
}

/**
 * Where the month's money went, largest first, each category's share of
 * the positive nets (they add up to 100 %). Each line shows its category's
 * expenses: the name is the button and it covers the line (.drill-row), so
 * the amount and the share stay plain text. An empty month is one quiet line.
 */
export default function CategoryBreakdown({ shares, loaded, active, onShow }: Props) {
  const { t } = useLang()
  const money = useMoney()

  return (
    <article className="card spend-cats-card">
      <header className="card-head">
        <h2>{t('spend.catTitle')}</h2>
      </header>
      {!loaded ? (
        <p className="spend-cats-empty">—</p>
      ) : shares.length === 0 ? (
        <p className="spend-cats-empty">{t('spend.catNone')}</p>
      ) : (
        <ul className="spend-cat-list">
          {shares.map((s) => {
            const name = t(categoryKey(s.category))
            return (
              <li key={s.category} className="spend-cat-row drill-row" data-cat={s.category}>
                <span className="spend-cat-main">
                  <button
                    type="button"
                    className="spend-cat-name drill"
                    aria-label={t('spend.showCategory', { name })}
                    aria-current={active === s.category || undefined}
                    onClick={() => onShow({ category: s.category })}
                  >
                    <CategoryIcon category={s.category} size={14} />
                    {name}
                  </button>
                  <span className={`spend-cat-amount${s.amount < 0 ? ' refund' : ''}`}>{money.plain(s.amount)}</span>
                </span>
                <span className="bd-bar" aria-hidden="true">
                  <span className="bd-fill ink" style={{ width: `${s.share * 100}%` }} />
                </span>
                <span className="spend-cat-share">{t('spend.share', { pct: fmtPct(s.share * 100) })}</span>
              </li>
            )
          })}
        </ul>
      )}
    </article>
  )
}
