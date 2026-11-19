import { toCategory } from '../../lib/categories'
import { fmtPct } from '../../lib/format'
import { useLang } from '../../lib/i18n'
import { useMoney } from '../../lib/money'
import { levelClass, type BudgetLine, type Drill, type ExpenseFilter } from '../../lib/spend'
import CategoryIcon from './CategoryIcon'

interface Props {
  lines: BudgetLine[]
  loaded: boolean
  onEdit: () => void
  /** The list's filter: the line of the card or category it shows reads as current. */
  filter: ExpenseFilter
  /** A line shows the expenses it counts in the list below (ExpensesView): its card's, its category's, the month's. */
  onShow: (d: Drill) => void
}

/** Whether a line counts exactly what the list is narrowed to (the monthly total never reads as current). */
const isCurrent = (d: Drill, f: ExpenseFilter): boolean => d !== 'all' && ('card' in d ? f.card === d.card : f.category === d.category)

/**
 * Each monthly budget with what the shown month spent against it: the total,
 * each card's, each category's. Two lines a budget: its name, then
 * "$338.81 of $400.00 · $61.19 left" (or "· $12.00 over"), with the bar
 * under them. Amber from 80 %, red once over (the loss limit's thresholds);
 * always said in words too, never by colour alone. Tapping a line shows its
 * expenses: the name is the button, and it covers the line (.drill-row), so
 * the figures and the bar stay what they are for a screen reader. The
 * monthly total shows the whole month. With no budgets, one quiet line and
 * "Set one" in the head: the card takes no more room than that.
 */
export default function BudgetsPanel({ lines, loaded, onEdit, filter, onShow }: Props) {
  const { t } = useLang()
  const money = useMoney()
  const empty = loaded && lines.length === 0
  // Nothing to list (none set, or not loaded yet): as tall as its one line, not as the chart beside it.
  const compact = !loaded || empty

  return (
    <article className={`card budgets-card${compact ? ' is-compact' : ''}`}>
      <header className="card-head">
        <h2>{t('budget.title')}</h2>
        <button type="button" className="btn btn-ghost budget-edit-btn" onClick={onEdit}>
          {t(empty ? 'budget.setOne' : 'budget.edit')}
        </button>
      </header>
      {!loaded ? (
        <p className="budget-empty">—</p>
      ) : empty ? (
        <p className="budget-empty">{t('budget.noneSet')}</p>
      ) : (
        <ul className="budget-list">
          {lines.map((line) => {
            const name = 'text' in line.label ? line.label.text : t(line.label.key, line.label.vars)
            const { level, spent, limit, left, ratio } = line.state
            const pct = Math.round(ratio * 100)
            const { drill } = line
            const action = drill === 'all' ? t('budget.showAll') : 'card' in drill ? t('spend.showCard', { name }) : t('spend.showCategory', { name })
            return (
              <li key={line.budget.id} className={`budget-row budget-${line.scope} is-${level} drill-row`} data-target={line.budget.target}>
                <button type="button" className="budget-name drill" title={name} aria-label={action} aria-current={isCurrent(drill, filter) || undefined} onClick={() => onShow(drill)}>
                  {line.scope === 'category' && <CategoryIcon category={toCategory(line.budget.target)} size={14} />}
                  {name}
                </button>
                <span className="budget-figures">
                  <span>{t('spend.budgetOf', { spent: money.plain(spent), limit: money.plain(limit ?? 0) })}</span>
                  <span className="budget-left">
                    {left !== null && left < 0 ? t('spend.budgetOver', { amount: money.plain(-left) }) : t('budget.left', { amount: money.plain(left ?? 0) })}
                    {level === 'near' && <span className="visually-hidden"> · {t('budget.near')}</span>}
                    {level === 'over' && <span className="visually-hidden"> · {t('budget.overWord')}</span>}
                  </span>
                </span>
                <div
                  className="bd-bar"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.min(100, pct)}
                  aria-valuetext={level === 'over' ? t('budget.overAria', { pct: fmtPct(pct) }) : undefined}
                  aria-label={t('budget.barAria', { name, pct: fmtPct(pct) })}
                >
                  <span className={`bd-fill ${levelClass(level)}`} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </article>
  )
}
