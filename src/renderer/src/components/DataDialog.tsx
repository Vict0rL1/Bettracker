import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import type { BankrollMove, Bet, BetInput, OddsFormat, Settings } from '../../../shared/types'
import type { ImportBatch } from '../data/imports'
import { readBackup, planRestore, type Backup, type BadEntry, type RestorePlan } from '../lib/backup'
import { refusalText } from '../lib/betForm'
import { parseBetsCsv, type Rejection } from '../lib/csv'
import { humanDate } from '../lib/dates'
import { useLang } from '../lib/i18n'
import { fingerprint, planImport, type ImportPlan, type PlannedRow } from '../lib/importPlan'
import { useMoney } from '../lib/money'
import type { StringKey } from '../lib/strings'
import { newId } from '../lib/uuid'
import { toneOf } from './DayModal'
import { ArchiveIcon, CloseIcon, DownloadIcon, UploadIcon } from './icons'

export interface ImportChoice {
  rows: BetInput[]
  file: string
  fingerprint: string
  /** Possible duplicates left out, and lines rejected: for the toast. */
  skipped: number
  rejected: number
}

export interface RestoreChoice {
  plan: RestorePlan
  keepDuplicates: boolean
  replaceSettings: boolean
  file: string
  fingerprint: string
}

interface Props {
  bets: Bet[]
  moves: BankrollMove[]
  settings: Settings
  account: { id: string; email: string | null }
  oddsFormat: OddsFormat
  /** The deposits and withdrawals and the settings have loaded: a backup has them all. */
  complete: boolean
  batches: ImportBatch[]
  /** Imports still on their way, by their op. */
  importing: ReadonlyMap<string, { done: number; total: number }>
  onExportCsv: () => void
  onDownloadBackup: () => void
  /** Each resolves once queued, and throws when refused: the dialog says why. */
  onImport: (choice: ImportChoice) => Promise<void>
  onRestore: (choice: RestoreChoice) => Promise<void>
  onUndoBatch: (batch: ImportBatch) => void
  onClose: () => void
}

type Step =
  | { kind: 'menu' }
  | { kind: 'import'; file: string; fingerprint: string; plan: ImportPlan; fileProblem: StringKey | null }
  | { kind: 'restore'; file: string; fingerprint: string; backup: Backup; bad: BadEntry[]; plan: RestorePlan }
  | { kind: 'restoreProblem'; file: string; key: StringKey; vars?: Record<string, string | number> }

const SHOWN = 50

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'

/**
 * Everything that goes in and out of the app: the bets CSV (in and out), a
 * full backup (out) and its restore (in), and the imports made on this
 * device, each of which can be undone. Nothing goes in without a review step
 * first, which says what will be added, what looks like a bet already here,
 * and what can't go in, and why.
 */
export default function DataDialog(props: Props) {
  const { bets, moves, settings, account, oddsFormat, complete, batches, importing, onExportCsv, onDownloadBackup, onImport, onRestore, onUndoBatch, onClose } = props
  const { t, tn } = useLang()
  const money = useMoney()
  const titleId = useId()
  const csvRef = useRef<HTMLInputElement>(null)
  const backupRef = useRef<HTMLInputElement>(null)
  const stepHeadRef = useRef<HTMLHeadingElement>(null)
  const [step, setStep] = useState<Step>({ kind: 'menu' })
  const [keepDuplicates, setKeepDuplicates] = useState(false)
  const [replaceSettings, setReplaceSettings] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)

  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  // A dialog: focus starts inside, Tab stays inside, Escape closes, and the
  // focus goes back where it came from.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        closeRef.current()
        return
      }
      if (e.key !== 'Tab' || !dialogRef.current) return
      const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null)
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (before?.isConnected) before.focus()
    }
  }, [])

  // A new step takes the focus to its heading, so a screen reader starts there.
  useEffect(() => {
    if (step.kind !== 'menu') stepHeadRef.current?.focus()
  }, [step.kind])

  const go = (next: Step): void => {
    setKeepDuplicates(false)
    setReplaceSettings(false)
    setRefusal(null)
    setStep(next)
  }

  const pickCsv = async (file: File): Promise<void> => {
    const text = await file.text()
    const parsed = parseBetsCsv(text, oddsFormat)
    go({ kind: 'import', file: file.name, fingerprint: fingerprint(text), plan: planImport(parsed, bets), fileProblem: parsed.fileProblem })
  }

  const pickBackup = async (file: File): Promise<void> => {
    const text = await file.text()
    const read = readBackup(text)
    if (!read.ok) {
      go({ kind: 'restoreProblem', file: file.name, key: read.key, vars: read.vars })
      return
    }
    const plan = planRestore(read.backup, { userId: account.id, bets, moves, settings }, newId)
    go({ kind: 'restore', file: file.name, fingerprint: fingerprint(text), backup: read.backup, bad: read.bad, plan })
    // The settings are offered, not imposed: replaced only when asked (see planRestore).
    setReplaceSettings(false)
  }

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setRefusal(null)
    try {
      await action()
      // Done: the toast says what happened, and offers Undo.
      closeRef.current()
    } catch (err) {
      setRefusal(refusalText(err, t))
    } finally {
      setBusy(false)
    }
  }

  const rowLine = (r: PlannedRow): ReactElement => {
    const status = r.input.status ?? 'pending'
    const tags = [r.input.sport, r.input.book, r.input.betType].filter(Boolean).join(' · ')
    return (
      <li key={r.line} className="imp-row">
        <span className="imp-line">{t('imp.line', { n: r.line })}</span>
        <span className="imp-date">{humanDate(r.input.date)}</span>
        <span className={`pill ${toneOf(status)}`}>{t(`status.${status}`)}</span>
        <span className="imp-amt">{r.input.amount === null || r.input.amount === undefined ? '—' : money.signed(r.input.amount)}</span>
        {tags && <span className="imp-tags">{tags}</span>}
      </li>
    )
  }

  const rejectedList = (list: Rejection[]): ReactElement => (
    <ul className="imp-list imp-rejected">
      {list.slice(0, SHOWN).map((r) => (
        <li key={r.line}>
          <span className="imp-line">{t('imp.line', { n: r.line })}</span> {t(r.key, r.vars)}
        </li>
      ))}
      {list.length > SHOWN && <li className="imp-more">{t('imp.more', { n: list.length - SHOWN })}</li>}
    </ul>
  )

  const batchState = (b: ImportBatch): string => {
    if (b.undone) return t('data.batchUndone')
    const going = importing.get(b.id)
    if (going) return t('data.batchGoing', { done: going.done, total: going.total })
    return t('data.batchDone')
  }

  const header = (
    <header className="modal-head">
      <h2 id={titleId}>{t('data.title')}</h2>
      <button type="button" className="btn-icon" aria-label={t('common.close')} onClick={onClose}>
        <CloseIcon />
      </button>
    </header>
  )

  let body: ReactElement
  if (step.kind === 'import') {
    const { plan } = step
    const earlier = batches.find((b) => b.fingerprint === step.fingerprint && b.kind !== 'restore' && !b.undone)
    const running = earlier ? importing.get(earlier.id) : undefined
    const rows = [...plan.fresh, ...(keepDuplicates ? plan.duplicates : [])].sort((a, b) => a.line - b.line)
    const confirmImport = (): Promise<void> =>
      run(() =>
        onImport({
          rows: rows.map((r) => r.input),
          file: step.file,
          fingerprint: step.fingerprint,
          skipped: keepDuplicates ? 0 : plan.duplicates.length,
          rejected: plan.rejected.length
        })
      )
    body = (
      <div className="data-step">
        <h3 ref={stepHeadRef} tabIndex={-1}>
          {t('imp.title', { file: step.file })}
        </h3>
        {step.fileProblem ? (
          <p className="form-error" role="alert">
            {t(step.fileProblem)}
          </p>
        ) : (
          <>
            {earlier && (
              <p className="draft-note imp-same" role="status">
                {running
                  ? t('imp.sameFileRunning', { done: running.done, total: running.total })
                  : t('imp.sameFileDone', { date: humanDate(earlier.at.slice(0, 10)), bets: tn('bet', earlier.ids.length) })}
              </p>
            )}
            <p className="imp-summary" aria-live="polite">
              {t('imp.summary', { ready: plan.fresh.length, dups: plan.duplicates.length, rejected: plan.rejected.length })}
            </p>

            {plan.fresh.length > 0 && (
              <section className="imp-section">
                <h4>{t('imp.readyTitle', { n: plan.fresh.length })}</h4>
                <ul className="imp-list">{plan.fresh.slice(0, 5).map(rowLine)}</ul>
                {plan.fresh.length > 5 && <p className="imp-more">{t('imp.more', { n: plan.fresh.length - 5 })}</p>}
              </section>
            )}

            {plan.duplicates.length > 0 && (
              <section className="imp-section imp-dups">
                <h4>{t('imp.dupsTitle', { n: plan.duplicates.length })}</h4>
                <p className="hint">{t('imp.dupsHelp')}</p>
                <fieldset className="imp-choice">
                  <legend className="visually-hidden">{t('imp.dupsChoice')}</legend>
                  <label>
                    <input type="radio" name="dups" checked={!keepDuplicates} onChange={() => setKeepDuplicates(false)} /> {t('imp.dupsSkip')}
                  </label>
                  <label>
                    <input type="radio" name="dups" checked={keepDuplicates} onChange={() => setKeepDuplicates(true)} /> {t('imp.dupsKeep')}
                  </label>
                </fieldset>
                <ul className="imp-list">{plan.duplicates.slice(0, SHOWN).map(rowLine)}</ul>
                {plan.duplicates.length > SHOWN && <p className="imp-more">{t('imp.more', { n: plan.duplicates.length - SHOWN })}</p>}
              </section>
            )}

            {plan.sameInFile > 0 && <p className="hint">{t('imp.sameInFile', { n: plan.sameInFile })}</p>}
            {plan.noStake > 0 && <p className="hint">{t('imp.noStake', { n: plan.noStake })}</p>}

            {plan.rejected.length > 0 && (
              <section className="imp-section">
                <h4>{t('imp.rejectedTitle', { n: plan.rejected.length })}</h4>
                {rejectedList(plan.rejected)}
              </section>
            )}
          </>
        )}

        {refusal && (
          <p className="form-error" role="alert">
            {refusal}
          </p>
        )}
        <footer className="modal-actions">
          {rows.length === 0 && !step.fileProblem && <span className="hint imp-nothing">{t('imp.nothing')}</span>}
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={() => go_menu()}>
            {t('imp.cancel')}
          </button>
          {rows.length > 0 &&
            (running ? (
              <button type="button" className="btn btn-ghost imp-again" disabled={busy} onClick={() => void confirmImport()}>
                {t('imp.againAnyway')}
              </button>
            ) : (
              <button type="button" className="btn btn-primary imp-go" disabled={busy} onClick={() => void confirmImport()}>
                {t('imp.go', { bets: tn('bet', rows.length) })}
              </button>
            ))}
        </footer>
      </div>
    )
  } else if (step.kind === 'restore') {
    const { plan, backup } = step
    const addBets = plan.newBets.length + (keepDuplicates ? plan.duplicateBets.length : 0)
    const nothing = addBets === 0 && plan.newMoves.length === 0 && !(replaceSettings && plan.settingsDiffer)
    body = (
      <div className="data-step">
        <h3 ref={stepHeadRef} tabIndex={-1}>
          {t('backup.restoreTitle', { file: step.file })}
        </h3>
        <p className="hint">
          {t('backup.from', { email: backup.account.email ?? '—', date: backup.exportedAt ? humanDate(backup.exportedAt.slice(0, 10)) : '—' })}
        </p>
        <p className="draft-note">{t('backup.onlyAdds')}</p>
        {plan.otherAccount && (
          <p className="draft-note" role="status">
            {t('backup.otherAccount')}
          </p>
        )}
        <ul className="imp-list restore-counts" aria-live="polite">
          <li>{t('backup.betsNew', { n: plan.newBets.length })}</li>
          {plan.sameBets > 0 && <li>{t('backup.betsSame', { n: plan.sameBets })}</li>}
          {plan.changedBets > 0 && <li>{t('backup.betsChanged', { n: plan.changedBets })}</li>}
          <li>{t('backup.movesNew', { n: plan.newMoves.length })}</li>
          {plan.sameMoves > 0 && <li>{t('backup.movesSame', { n: plan.sameMoves })}</li>}
          {plan.changedMoves > 0 && <li>{t('backup.movesChanged', { n: plan.changedMoves })}</li>}
        </ul>

        {plan.duplicateBets.length > 0 && (
          <section className="imp-section imp-dups">
            <h4>{t('imp.dupsTitle', { n: plan.duplicateBets.length })}</h4>
            <p className="hint">{t('imp.dupsHelp')}</p>
            <fieldset className="imp-choice">
              <legend className="visually-hidden">{t('imp.dupsChoice')}</legend>
              <label>
                <input type="radio" name="rdups" checked={!keepDuplicates} onChange={() => setKeepDuplicates(false)} /> {t('imp.dupsSkip')}
              </label>
              <label>
                <input type="radio" name="rdups" checked={keepDuplicates} onChange={() => setKeepDuplicates(true)} /> {t('imp.dupsKeep')}
              </label>
            </fieldset>
          </section>
        )}

        {plan.settingsDiffer && (
          <section className="imp-section">
            <h4>{t('backup.settingsTitle')}</h4>
            <label className="check-line">
              <input type="checkbox" className="restore-settings" checked={replaceSettings} onChange={(e) => setReplaceSettings(e.target.checked)} />
              {t('backup.replaceSettings')}
            </label>
            <p className="hint">
              {t('backup.settingsWere', {
                odds: t(`odds.${backup.settings.oddsFormat}`),
                bankroll: backup.settings.startingBankroll === null ? '—' : money.bankroll(backup.settings.startingBankroll),
                unit: backup.settings.unitSize === null ? '—' : String(backup.settings.unitSize)
              })}
            </p>
          </section>
        )}

        {step.bad.length > 0 && (
          <section className="imp-section">
            <h4>{t('backup.badTitle', { n: step.bad.length })}</h4>
            <ul className="imp-list imp-rejected">
              {step.bad.slice(0, SHOWN).map((b) => (
                <li key={`${b.kind}${b.index}`}>
                  <span className="imp-line">{t(b.kind === 'bet' ? 'backup.betN' : 'backup.moveN', { n: b.index })}</span> {t(b.key, b.vars)}
                </li>
              ))}
              {step.bad.length > SHOWN && <li className="imp-more">{t('imp.more', { n: step.bad.length - SHOWN })}</li>}
            </ul>
          </section>
        )}

        {refusal && (
          <p className="form-error" role="alert">
            {refusal}
          </p>
        )}
        <footer className="modal-actions">
          {nothing && <span className="hint imp-nothing">{t('backup.nothing')}</span>}
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={() => go_menu()}>
            {t('imp.cancel')}
          </button>
          {!nothing && (
            <button
              type="button"
              className="btn btn-primary restore-go"
              disabled={busy}
              onClick={() => void run(() => onRestore({ plan, keepDuplicates, replaceSettings, file: step.file, fingerprint: step.fingerprint }))}
            >
              {t('backup.restoreGo')}
            </button>
          )}
        </footer>
      </div>
    )
  } else if (step.kind === 'restoreProblem') {
    body = (
      <div className="data-step">
        <h3 ref={stepHeadRef} tabIndex={-1}>
          {t('backup.restoreTitle', { file: step.file })}
        </h3>
        <p className="form-error" role="alert">
          {t(step.key, step.vars)}
        </p>
        <footer className="modal-actions">
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={() => go_menu()}>
            {t('imp.cancel')}
          </button>
        </footer>
      </div>
    )
  } else {
    body = (
      <>
        <section className="data-section">
          <h3>{t('data.betsTitle')}</h3>
          <p className="hint">{t('data.betsHint')}</p>
          <div className="data-actions">
            <button type="button" className="btn btn-ghost data-import" onClick={() => csvRef.current?.click()}>
              <UploadIcon /> {t('data.importCsv')}
            </button>
            <button type="button" className="btn btn-ghost data-export" disabled={bets.length === 0} aria-describedby={bets.length === 0 ? `${titleId}-empty` : undefined} onClick={onExportCsv}>
              <DownloadIcon /> {t('data.exportCsv')}
            </button>
          </div>
          {bets.length === 0 && (
            <p className="hint" id={`${titleId}-empty`}>
              {t('header.exportEmpty')}
            </p>
          )}
        </section>

        <section className="data-section">
          <h3>{t('data.backupTitle')}</h3>
          <p className="hint">{t('data.backupHint')}</p>
          <div className="data-actions">
            <button type="button" className="btn btn-ghost data-backup" disabled={!complete} aria-describedby={complete ? undefined : `${titleId}-wait`} onClick={onDownloadBackup}>
              <ArchiveIcon /> {t('data.downloadBackup')}
            </button>
            <button type="button" className="btn btn-ghost data-restore" disabled={!complete} aria-describedby={complete ? undefined : `${titleId}-wait`} onClick={() => backupRef.current?.click()}>
              <UploadIcon /> {t('data.restoreBackup')}
            </button>
          </div>
          {!complete && (
            <p className="hint" id={`${titleId}-wait`}>
              {t('data.waitLoad')}
            </p>
          )}
        </section>

        <section className="data-section">
          <h3>{t('data.historyTitle')}</h3>
          {batches.length === 0 ? (
            <p className="hint">{t('data.noImports')}</p>
          ) : (
            <ul className="imp-list data-batches">
              {batches.map((b) => (
                <li key={b.id} className="data-batch">
                  <span className="data-batch-text">
                    <strong>{b.file}</strong>
                    <span className="hint">
                      {humanDate(b.at.slice(0, 10))} · {tn('bet', b.ids.length)}
                      {b.moveIds && b.moveIds.length > 0 ? ` · ${t('data.movesN', { n: b.moveIds.length })}` : ''} · {batchState(b)}
                    </span>
                  </span>
                  {!b.undone && (
                    <button type="button" className="btn btn-ghost data-undo" onClick={() => onUndoBatch(b)}>
                      {t('data.undoImport')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="hint">{t('data.historyHint')}</p>
        </section>

        <footer className="modal-actions">
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.done')}
          </button>
        </footer>
      </>
    )
  }

  function go_menu(): void {
    go({ kind: 'menu' })
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal card data-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef}>
        {header}
        <input
          ref={csvRef}
          type="file"
          accept=".csv,text/csv"
          className="visually-hidden data-csv-input"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void pickCsv(file)
            // Reset so picking the same file twice still fires a change event.
            e.target.value = ''
          }}
        />
        <input
          ref={backupRef}
          type="file"
          accept=".json,application/json"
          className="visually-hidden data-backup-input"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void pickBackup(file)
            e.target.value = ''
          }}
        />
        {body}
      </div>
    </div>
  )
}
