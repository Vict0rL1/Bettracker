import { useEffect, useId, useRef } from 'react'
import type { BudgetScope, Expense, ExpenseBudget, ExpenseCard, ExpenseCardInput } from '../../../../shared/types'
import type { MonthKey } from '../../lib/dates'
import { useLang } from '../../lib/i18n'
import type { MonthSpend } from '../../lib/spend'
import { CloseIcon } from '../icons'
import BudgetEditor, { type CommitRegistry } from './BudgetEditor'
import CardsEditor from './CardsEditor'
import CurrencyPicker from './CurrencyPicker'
import type { ExpenseSettingsSection } from './ExpensesView'
import { useDialog } from './useDialog'

export interface ExpenseSettingsProps {
  /** Scrolled into view, its first control focused, on open. */
  section: ExpenseSettingsSection
  cards: ExpenseCard[]
  budgets: ExpenseBudget[]
  expenses: Expense[]
  month: MonthSpend
  ym: MonthKey
  cardsLoaded: boolean
  budgetsLoaded: boolean
  settingsLoaded: boolean
  /** cardDeleteMode can hard-delete (expenses loaded and read this session); otherwise every delete archives. */
  expensesSure: boolean
  currency: string
  /** A read or a write of the expense tables went through: 008 has run. */
  has008: boolean
  /** A read found the tables missing, and nothing has proved them since. */
  needs008: boolean
  onSaveCard: (input: ExpenseCardInput, id?: string) => Promise<void>
  onDeleteCard: (card: ExpenseCard) => Promise<void>
  onRestoreCard: (card: ExpenseCard) => Promise<void>
  onSetBudget: (scope: BudgetScope, target: string, limit: number | null) => Promise<void>
  onSetCurrency: (code: string) => void
  onClose: () => void
}

const FIRST: Record<ExpenseSettingsSection, string> = {
  cards: '.expset-cards .paycard-name-input',
  budgets: '.expset-budgets .budget-input:not(:disabled)',
  currency: '.expset-currency .currency-select:not(:disabled)'
}

/**
 * Expense settings: the cards, the monthly budgets and the currency. The
 * budgets and the currency are written only once the database is known to
 * have migration 008 (a read or write of its tables went through here):
 * before that they are disabled, and the sheet says why. Every way out
 * commits what was typed in a budget box first.
 */
export default function ExpenseSettings(p: ExpenseSettingsProps) {
  const { t } = useLang()
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const registry = useRef<CommitRegistry>(new Map()).current

  const closeRef = useRef(p.onClose)
  closeRef.current = p.onClose
  const close = (): void => {
    for (const commit of registry.values()) commit()
    closeRef.current()
  }
  useDialog(dialogRef, close)

  // The section asked for, in view and focused (on a touch screen the dialog itself: no keyboard popping up).
  const section = p.section
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.querySelector(`.expset-${section}`)?.scrollIntoView?.({ block: 'nearest' })
    const coarse = window.matchMedia?.('(pointer: coarse)').matches
    const target = coarse ? null : dialog.querySelector<HTMLElement>(FIRST[section])
    ;(target ?? dialog).focus({ preventScroll: true })
  }, [section])

  const budgetsOn = p.budgetsLoaded && p.has008
  const currencyOn = p.settingsLoaded && p.has008

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div ref={dialogRef} className="modal card expense-settings-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="modal-head">
          <h2 id={titleId}>{t('expset.title')}</h2>
          <button type="button" className="btn-icon" aria-label={t('common.close')} onClick={close}>
            <CloseIcon />
          </button>
        </header>

        {p.needs008 ? (
          <p className="draft-note expset-needs008" role="status">
            {t('expset.needs008')}
          </p>
        ) : (
          !p.has008 && <p className="hint expset-connect">{t('expset.connectFirst')}</p>
        )}

        <CardsEditor
          cards={p.cards}
          cardsLoaded={p.cardsLoaded}
          expenses={p.expenses}
          expensesSure={p.expensesSure}
          onSave={p.onSaveCard}
          onDelete={p.onDeleteCard}
          onRestore={p.onRestoreCard}
        />
        <BudgetEditor cards={p.cards} budgets={p.budgets} month={p.month} ym={p.ym} enabled={budgetsOn} currency={p.currency} registry={registry} onSet={p.onSetBudget} />
        <CurrencyPicker currency={p.currency} enabled={currencyOn} onChange={p.onSetCurrency} />

        <footer className="modal-actions">
          <span className="spacer" />
          <button type="button" className="btn btn-primary expset-done" onClick={close}>
            {t('common.done')}
          </button>
        </footer>
      </div>
    </div>
  )
}
