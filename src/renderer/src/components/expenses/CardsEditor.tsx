import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { CardKind, Expense, ExpenseCard, ExpenseCardInput } from '../../../../shared/types'
import { refusalText, type Problem } from '../../lib/betForm'
import { useLang } from '../../lib/i18n'
import { InputError } from '../../lib/validate'
import FieldError, { describedBy } from '../FieldError'
import { PencilIcon, TrashIcon } from '../icons'

interface Props {
  cards: ExpenseCard[]
  cardsLoaded: boolean
  /** Every expense: a card any of them uses is archived instead of deleted. */
  expenses: readonly Expense[]
  /** The expense list is known for sure (loaded and read this session): otherwise every delete archives. */
  expensesSure: boolean
  onSave: (input: ExpenseCardInput, id?: string) => Promise<void>
  onDelete: (card: ExpenseCard) => Promise<void>
  onRestore: (card: ExpenseCard) => Promise<void>
}

interface Draft {
  name: string
  last4: string
  kind: CardKind
}

const BLANK: Draft = { name: '', last4: '', kind: 'credit' }

/**
 * One card's name, last digits and kind: the add form at the foot of the list,
 * and the same form in place of a card being edited. Problems come back from
 * the card's own checks (normalizeCard), said under their box.
 */
function CardForm({ start, editing, onSave, onCancel, autoFocus }: { start: Draft; editing: boolean; onSave: (d: Draft) => Promise<void>; onCancel?: () => void; autoFocus?: boolean }) {
  const { t } = useLang()
  const id = useId()
  const [d, setD] = useState<Draft>(start)
  const [problem, setProblem] = useState<{ field: 'name' | 'last4' | 'form'; problem: Problem | null; text?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const last4Ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (autoFocus) nameRef.current?.focus()
  }, [autoFocus])

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setProblem(null)
    try {
      await onSave(d)
      if (!editing) setD(BLANK)
      nameRef.current?.focus()
    } catch (err) {
      if (err instanceof InputError && (err.code === 'cardName' || err.code === 'cardLast4')) {
        const field = err.code === 'cardName' ? 'name' : 'last4'
        setProblem({ field, problem: { key: `invalid.${err.code}` } })
        ;(field === 'name' ? nameRef : last4Ref).current?.focus()
      } else setProblem({ field: 'form', problem: null, text: refusalText(err, t) })
    } finally {
      setBusy(false)
    }
  }

  const nameProblem = problem?.field === 'name' ? problem.problem : null
  const last4Problem = problem?.field === 'last4' ? problem.problem : null
  const kindId = `${id}-kind`

  return (
    <form className={`paycard-form${editing ? ' is-editing' : ''}`} noValidate onSubmit={(e) => void submit(e)}>
      <label className="field paycard-name-field">
        <span className="field-label">{t('expset.cardName')}</span>
        <input
          ref={nameRef}
          type="text"
          className="paycard-name-input"
          maxLength={40}
          autoComplete="off"
          placeholder={t('expset.cardNamePlaceholder')}
          value={d.name}
          aria-invalid={nameProblem !== null}
          aria-describedby={describedBy(nameProblem && `${id}-name-err`)}
          onChange={(e) => setD({ ...d, name: e.target.value })}
        />
        <FieldError id={`${id}-name-err`} problem={nameProblem} />
      </label>
      <label className="field paycard-last4-field">
        <span className="field-label">{t('expset.last4')}</span>
        <input
          ref={last4Ref}
          type="text"
          className="paycard-last4-input"
          inputMode="numeric"
          maxLength={4}
          pattern="\d{4}"
          autoComplete="off"
          placeholder="1234"
          value={d.last4}
          aria-invalid={last4Problem !== null}
          aria-describedby={describedBy(last4Problem && `${id}-last4-err`)}
          onChange={(e) => setD({ ...d, last4: e.target.value })}
        />
        <FieldError id={`${id}-last4-err`} problem={last4Problem} />
      </label>
      <div className="field paycard-kind-field">
        <span className="field-label" id={kindId}>
          {t('expset.kind')}
        </span>
        <div className="scope-toggle paycard-kind" role="group" aria-labelledby={kindId}>
          {(['credit', 'debit'] as const).map((k) => (
            <button key={k} type="button" className="scope-btn" aria-pressed={d.kind === k} onClick={() => setD({ ...d, kind: k })}>
              {t(k === 'credit' ? 'expset.credit' : 'expset.debit')}
            </button>
          ))}
        </div>
      </div>
      <div className="paycard-form-actions">
        {editing && onCancel && (
          <button type="button" className="btn btn-ghost paycard-cancel" onClick={onCancel}>
            {t('expset.cancelEdit')}
          </button>
        )}
        {editing ? (
          <button type="submit" className="btn btn-primary paycard-save" disabled={busy}>
            {t('common.save')}
          </button>
        ) : (
          <button type="submit" className="btn btn-ghost paycard-add" disabled={busy}>
            {t('expset.addCard')}
          </button>
        )}
      </div>
      {problem?.field === 'form' && (
        <p className="form-error paycard-refusal" role="alert">
          {problem.text}
        </p>
      )}
    </form>
  )
}

/**
 * The cards: add, rename, delete. A card any expense uses (or any card while
 * the expense list isn't known for sure) is archived instead: hidden from the
 * pickers, its name kept on its expenses, and back with Restore.
 */
export default function CardsEditor({ cards, cardsLoaded, expenses, expensesSure, onSave, onDelete, onRestore }: Props) {
  const { t } = useLang()
  const [editing, setEditing] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const active = cards.filter((c) => !c.archived)
  const archived = cards.filter((c) => c.archived)
  const used = new Set(expenses.map((e) => e.cardId?.toLowerCase()))
  const anyUsed = active.some((c) => used.has(c.id.toLowerCase()))

  const deleteClick = (card: ExpenseCard): void => {
    if (timer.current) clearTimeout(timer.current)
    if (confirming === card.id) {
      setConfirming(null)
      void onDelete(card)
      return
    }
    setConfirming(card.id)
    timer.current = setTimeout(() => setConfirming(null), 3000)
  }

  return (
    <section className="expset-section expset-cards" aria-labelledby="expset-cards-title">
      <h3 id="expset-cards-title">{t('expset.cards')}</h3>
      <p className="hint">{t('expset.cardsHint')}</p>
      {!cardsLoaded ? (
        <p className="hint">{t('exp.loading')}</p>
      ) : (
        <>
          {active.length > 0 && (
            <ul className="paycard-list">
              {active.map((c) =>
                editing === c.id ? (
                  <li key={c.id} className="paycard-row is-editing" data-id={c.id}>
                    <CardForm
                      start={{ name: c.name, last4: c.last4, kind: c.kind }}
                      editing
                      autoFocus
                      onSave={async (d) => {
                        await onSave({ name: d.name, last4: d.last4, kind: d.kind, archived: false }, c.id)
                        setEditing(null)
                      }}
                      onCancel={() => setEditing(null)}
                    />
                  </li>
                ) : (
                  <li key={c.id} className="paycard-row" data-id={c.id}>
                    <span className="paycard-text">
                      <span className="paycard-name" title={c.name}>
                        {c.name}
                      </span>
                      <span className="paycard-meta">
                        {c.last4 && <span>•••• {c.last4}</span>}
                        <span>{t(c.kind === 'debit' ? 'expset.debit' : 'expset.credit')}</span>
                      </span>
                    </span>
                    <button type="button" className="btn-icon paycard-edit" aria-label={t('expset.editCard', { name: c.name })} title={t('common.edit')} onClick={() => setEditing(c.id)}>
                      <PencilIcon />
                    </button>
                    <button
                      type="button"
                      className={`btn-icon danger paycard-delete ${confirming === c.id ? 'confirming' : ''}`}
                      aria-label={confirming === c.id ? t('common.clickAgain') : t('expset.deleteCard', { name: c.name })}
                      title={confirming === c.id ? t('common.clickAgain') : t('common.delete')}
                      onClick={() => deleteClick(c)}
                    >
                      {confirming === c.id ? <span className="confirm-text">{t('common.sure')}</span> : <TrashIcon />}
                    </button>
                  </li>
                )
              )}
            </ul>
          )}
          {active.length > 0 && (anyUsed || !expensesSure) && <p className="hint paycard-archive-note">{t('expset.archiveNote')}</p>}
          <CardForm start={BLANK} editing={false} onSave={(d) => onSave({ name: d.name, last4: d.last4, kind: d.kind, archived: false })} />
          {archived.length > 0 && (
            <details className="paycard-archived">
              <summary>
                {t('expset.archived')} <span className="paycard-archived-count">{archived.length}</span>
              </summary>
              <ul className="paycard-list">
                {archived.map((c) => (
                  <li key={c.id} className="paycard-row is-archived" data-id={c.id}>
                    <span className="paycard-text">
                      <span className="paycard-name" title={c.name}>
                        {c.name}
                      </span>
                      <span className="paycard-meta">{c.last4 && <span>•••• {c.last4}</span>}</span>
                    </span>
                    <button type="button" className="btn btn-ghost paycard-restore" onClick={() => void onRestore(c)}>
                      {t('expset.restoreCard')}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  )
}
