import { toCategory } from '../../lib/categories'
import { fmtPct } from '../../lib/format'
import { useLang } from '../../lib/i18n'
import { useMoney } from '../../lib/money'
import type { BudgetLine } from '../../lib/spend'
import CategoryIcon from './CategoryIcon'

interface Props {
  lines: BudgetLine[]
  loaded: boolean
  onEdit: () => void
}

/**
 * Each monthly budget with what the shown month spent against it: the total,
 * each card's, each category's. Amber from 80 %, red once over (the loss
 * limit's thresholds); always said in words too, never by colour alone.
 */
export default function BudgetsPanel({ lines, loaded, onEdit }: Props) {
  const { t } = useLang()
  const money = useMoney()

  return (
    <article className="card budgets-card">
      <header className="card-head">
        <h2>{t('budget.title')}</h2>
        <button type="button" className="btn btn-ghost budget-edit-btn" onClick={onEdit}>
          {t('budget.edit')}
        </button>
      </header>
      {!loaded ? (
        <p className="empty-state budget-empty">{t('exp.loading')}</p>
      ) : lines.length === 0 ? (
        <p className="empty-state budget-empty">{t('budget.none')}</p>
      ) : (
        <ul className="budget-list">
          {lines.map((line) => {
            const name = 'text' in line.label ? line.label.text : t(line.label.key, line.label.vars)
            const { level, spent, limit, left, ratio } = line.state
            const pct = Math.round(ratio * 100)
            const fill = level === 'over' ? 'over' : level === 'near' ? 'near' : 'ink'
            return (
              <li key={line.budget.id} className={`budget-row budget-${line.scope} is-${level}`} data-target={line.budget.target}>
                <span className="budget-name" title={name}>
                  {line.scope === 'category' && <CategoryIcon category={toCategory(line.budget.target)} size={14} />}
                  {name}
                </span>
                <span className="budget-figures">{t('spend.budgetOf', { spent: money.plain(spent), limit: money.plain(limit ?? 0) })}</span>
                <div
                  className="bd-bar"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.min(100, pct)}
                  aria-valuetext={level === 'over' ? t('budget.overAria', { pct: fmtPct(pct) }) : undefined}
                  aria-label={t('budget.barAria', { name, pct: fmtPct(pct) })}
                >
                  <span className={`bd-fill ${fill}`} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
                </div>
                <span className="budget-left">
                  {left !== null && left < 0 ? t('spend.budgetOver', { amount: money.plain(-left) }) : t('budget.left', { amount: money.plain(left ?? 0) })}
                  {level === 'near' && <span className="visually-hidden"> · {t('budget.near')}</span>}
                  {level === 'over' && <span className="visually-hidden"> · {t('budget.overWord')}</span>}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </article>
  )
}
