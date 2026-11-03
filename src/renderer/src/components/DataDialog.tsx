import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react'
import type { BankrollMove, Bet, BetInput, OddsFormat, Settings } from '../../../shared/types'
import type { ImportBatch } from '../data/imports'
import { readBackup, planRestore, type Backup, type BadEntry, type RestorePlan } from '../lib/backup'
import { batchStatus, type BatchLive, type PartStatus } from '../lib/batchStatus'
import { refusalText } from '../lib/betForm'
import { parseBetsCsv, type ImportResult, type Rejection } from '../lib/csv'
import { humanDate } from '../lib/dates'
import { useLang } from '../lib/i18n'
import { fingerprint, planImport, type ImportPlan, type PlannedRow } from '../lib/importPlan'
import { useMoney } from '../lib/money'
import { formatOdds } from '../lib/odds'
import type { StringKey } from '../lib/strings'
import { newId } from '../lib/uuid'
import { toneOf } from './DayModal'
import { ArchiveIcon, CloseIcon, DownloadIcon, UploadIcon } from './icons'

/** A file as parsed, to plan it again against the bets as they are when it is imported. */
export type ParsedFile = Pick<ImportResult, 'rows' | 'lines' | 'rejected' | 'noStake'>

export interface ImportChoice {
  parsed: ParsedFile
  /** The plan the user reviewed (see ImportPlan.signature). */
  signature: string
  /** The possible duplicates to import anyway, by their line in the file. */
  keepLines: readonly number[]
  file: string
  fingerprint: string
}

export interface RestoreChoice {
  backup: Backup
  /** The plan the user reviewed. */
  plan: RestorePlan
  /** Another account's possible duplicates to add anyway, by their id in the backup. */
  keepSources: readonly string[]
  replaceSettings: boolean
  file: string
  fingerprint: string
}

/** 'changed': the data changed since the review; this is the plan now, to review again. */
export type ImportOutcome = { kind: 'done' } | { kind: 'changed'; plan: ImportPlan }
export type RestoreOutcome = { kind: 'done'; batch: string } | { kind: 'nothing' } | { kind: 'changed'; plan: RestorePlan }

interface Props {
  bets: Bet[]
  moves: BankrollMove[]
  settings: Settings
  account: { id: string; email: string | null }
  oddsFormat: OddsFormat
  /** The deposits and withdrawals and the settings have loaded: a backup has them all. */
  complete: boolean
  batches: ImportBatch[]
  /** Imports still on their way, by their batch. */
  importing: ReadonlyMap<string, { done: number; total: number }>
  /** Where a batch stands in the queues now (see lib/batchStatus.ts). */
  live: (batch: ImportBatch) => BatchLive
  /** No connection (or no session): what waits, waits for it. */
  offline: boolean
  onExportCsv: () => void
  onDownloadBackup: () => void
  /** Each resolves once queued (or with the plan as it is now), and throws when refused: the dialog says why. */
  onImport: (choice: ImportChoice) => Promise<ImportOutcome>
  onRestore: (choice: RestoreChoice) => Promise<RestoreOutcome>
  onUndoBatch: (batch: ImportBatch) => Promise<boolean>
  onSaveAgain: () => void
  onRetryRefused: () => void
  onClose: () => void
}

type Step =
  | { kind: 'menu' }
  | { kind: 'import'; file: string; fingerprint: string; parsed: ParsedFile; plan: ImportPlan; fileProblem: StringKey | null; keep: ReadonlySet<number>; changed: boolean }
  | { kind: 'restore'; file: string; fingerprint: string; backup: Backup; bad: BadEntry[]; plan: RestorePlan; keep: ReadonlySet<string>; changed: boolean }
  | { kind: 'restoreProblem'; file: string; key: StringKey; vars?: Record<string, string | number> }
  | { kind: 'result'; batch: string }

const SHOWN = 50
/** Possible duplicates shown at first, and added by each "Show more": each takes room to compare. */
const DUPS_SHOWN = 25

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'

/**
 * Everything that goes in and out of the app: the bets CSV (in and out), a
 * full backup (out) and its restore (in), and the imports made on this
 * device, each of which can be undone. Nothing goes in without a review step
 * first, which says what will be added, what looks like a bet already here,
 * and what can't go in, and why.
 */
/** A long list, shown `first` at a time, with the rest one "Show more" away. */
function Paged<T>({ items, first, step, render, className }: { items: readonly T[]; first: number; step: number; render: (item: T) => ReactNode; className: string }) {
  const { t } = useLang()
  const [shown, setShown] = useState(first)
  const visible = items.slice(0, shown)
  return (
    <>
      <ul className={className}>{visible.map(render)}</ul>
      {items.length > shown && (
        <p className="imp-more">
          <span className="hint">{t('imp.showing', { shown: visible.length, total: items.length })}</span>{' '}
          <button type="button" className="btn btn-ghost imp-show-more" onClick={() => setShown((n) => n + step)}>
            {t('imp.showMore', { n: Math.min(step, items.length - shown) })}
          </button>
        </p>
      )}
    </>
  )
}

/** A possible duplicate as the review compares it: the row of the file against the bet here. */
interface DupItem {
  key: string
  /** Its line in the file, for a CSV. */
  line?: number
  file: Pick<BetInput, 'date' | 'status' | 'amount' | 'stake' | 'odds' | 'closingOdds' | 'note' | 'sport' | 'book' | 'betType'>
  here: Bet
}

/**
 * The possible duplicates, each with a box to import it anyway and what it
 * looks like next to the bet here (the fields that decide a match, and the
 * note and closing odds, which don't). Skipping is the default; all of them
 * can be ticked or cleared at once.
 */
function DuplicatePicker({ items, keep, oddsFormat, onChange }: { items: DupItem[]; keep: ReadonlySet<string>; oddsFormat: OddsFormat; onChange: (next: Set<string>) => void }) {
  const { t } = useLang()
  const money = useMoney()
  const helpId = useId()
  const picked = items.filter((d) => keep.has(d.key)).length
  const odds = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : formatOdds(n, oddsFormat))
  const fields = (b: DupItem['file']): [string, string][] => {
    const status = b.status ?? 'pending'
    return [
      [t('imp.cmpDate'), humanDate(b.date)],
      [t('imp.cmpStatus'), t(`status.${status}`)],
      [t('imp.cmpStake'), b.stake === null || b.stake === undefined ? '—' : money.stake(b.stake)],
      [t('imp.cmpProfit'), b.amount === null || b.amount === undefined || status === 'pending' ? '—' : money.signed(b.amount)],
      [t('imp.cmpOdds'), odds(b.odds)],
      [t('imp.cmpClosing'), odds(b.closingOdds)],
      [t('imp.cmpTags'), [b.sport, b.book, b.betType].filter(Boolean).join(' · ') || '—'],
      [t('imp.cmpNote'), b.note?.trim() || '—']
    ]
  }
  const toggle = (key: string, on: boolean): void => {
    const next = new Set(keep)
    if (on) next.add(key)
    else next.delete(key)
    onChange(next)
  }
  return (
    <>
      <p className="hint" id={helpId}>
        {t('imp.dupsHelp')}
      </p>
      <div className="imp-dup-bulk" role="group" aria-label={t('imp.dupsChoice')}>
        <button type="button" className="btn btn-ghost imp-dup-all" disabled={picked === items.length} onClick={() => onChange(new Set(items.map((d) => d.key)))}>
          {t('imp.dupsAll', { n: items.length })}
        </button>
        <button type="button" className="btn btn-ghost imp-dup-none" disabled={picked === 0} onClick={() => onChange(new Set())}>
          {t('imp.dupsNone')}
        </button>
        <span className="hint imp-dup-count" aria-live="polite">
          {t('imp.dupsPicked', { k: picked, n: items.length })}
        </span>
      </div>
      <Paged
        items={items}
        first={DUPS_SHOWN}
        step={DUPS_SHOWN}
        className="imp-dup-list"
        render={(d) => {
          const mine = fields(d.file)
          const theirs = fields(d.here)
          const label = d.line !== undefined ? t('imp.dupImport', { n: d.line }) : t('imp.dupImport', { n: d.key.slice(0, 8) })
          return (
            <li key={d.key} className={`imp-dup ${keep.has(d.key) ? 'is-kept' : ''}`}>
              <label className="imp-dup-pick">
                <input type="checkbox" className="imp-dup-check" checked={keep.has(d.key)} aria-describedby={helpId} onChange={(e) => toggle(d.key, e.target.checked)} />
                <span>{label}</span>
              </label>
              <table className="imp-cmp">
                <thead>
                  <tr>
                    <td />
                    <th scope="col">{t('imp.cmpFile')}</th>
                    <th scope="col">{t('imp.cmpHere')}</th>
                  </tr>
                </thead>
                <tbody>
                  {mine.map(([name, value], i) => {
                    const differs = value !== theirs[i][1]
                    return (
                      <tr key={name} className={differs ? 'is-diff' : undefined}>
                        <th scope="row">{name}</th>
                        <td>
                          {value}
                          {differs && <span className="visually-hidden"> ({t('imp.cmpDiffers')})</span>}
                        </td>
                        <td>{theirs[i][1]}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </li>
          )
        }}
      />
    </>
  )
}

export default function DataDialog(props: Props) {
  const {
    bets,
    moves,
    settings,
    account,
    oddsFormat,
    complete,
    batches,
    importing,
    live,
    offline,
    onExportCsv,
    onDownloadBackup,
    onImport,
    onRestore,
    onUndoBatch,
    onSaveAgain,
    onRetryRefused,
    onClose
  } = props
  const { t, tn } = useLang()
  const money = useMoney()
  const titleId = useId()
  const csvRef = useRef<HTMLInputElement>(null)
  const backupRef = useRef<HTMLInputElement>(null)
  const stepHeadRef = useRef<HTMLHeadingElement>(null)
  const [step, setStep] = useState<Step>({ kind: 'menu' })
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
    setReplaceSettings(false)
    setRefusal(null)
    setStep(next)
  }

  // The data changed while a review is open (another window, another device,
  // the sync): the plan is made again, and if it is not the same the review
  // shows the new one and says so. Choices made for rows still in it stay.
  // The settings object is new on every render: what is in it is what counts.
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const settingsText = JSON.stringify(settings)
  useEffect(() => {
    setStep((cur) => {
      if (cur.kind === 'import' && !cur.fileProblem) {
        const plan = planImport(cur.parsed, bets)
        return plan.signature === cur.plan.signature ? cur : withImportPlan(cur, plan)
      }
      if (cur.kind === 'restore') {
        const plan = planRestore(cur.backup, { userId: account.id, bets, moves, settings: settingsRef.current }, newId)
        return plan.signature === cur.plan.signature ? cur : withRestorePlan(cur, plan)
      }
      return cur
    })
  }, [bets, moves, settingsText, account.id])

  const pickCsv = async (file: File): Promise<void> => {
    const text = await file.text()
    const parsed = parseBetsCsv(text, oddsFormat)
    go({
      kind: 'import',
      file: file.name,
      fingerprint: fingerprint(text),
      parsed,
      plan: planImport(parsed, bets),
      fileProblem: parsed.fileProblem,
      keep: new Set(),
      changed: false
    })
  }

  const pickBackup = async (file: File): Promise<void> => {
    const text = await file.text()
    const read = readBackup(text)
    if (!read.ok) {
      go({ kind: 'restoreProblem', file: file.name, key: read.key, vars: read.vars })
      return
    }
    const plan = planRestore(read.backup, { userId: account.id, bets, moves, settings }, newId)
    // The settings are offered, not imposed: replaced only when asked (see planRestore).
    go({ kind: 'restore', file: file.name, fingerprint: fingerprint(text), backup: read.backup, bad: read.bad, plan, keep: new Set(), changed: false })
  }

  /** Run what the review confirmed; it says whether the dialog closes or shows something next. */
  const run = async (action: () => Promise<'close' | 'stay'>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setRefusal(null)
    try {
      // Done: the toast (or the result) says what happened, and offers Undo.
      if ((await action()) === 'close') closeRef.current()
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
    <Paged
      items={list}
      first={SHOWN}
      step={SHOWN}
      className="imp-list imp-rejected"
      render={(r) => (
        <li key={r.line}>
          <span className="imp-line">{t('imp.line', { n: r.line })}</span> {t(r.key, r.vars)}
        </li>
      )}
    />
  )

  const batchState = (b: ImportBatch): string => {
    if (b.undone) return t('data.batchUndone')
    const going = importing.get(b.id)
    if (going && b.kind !== 'restore') return t('data.batchGoing', { done: going.done, total: going.total })
    const st = batchStatus(b, live(b))
    if (st.complete) return t(b.kind === 'restore' ? 'data.batchRestored' : 'data.batchDone')
    const states = [st.bets.state, st.moves.state, st.settings.state]
    if (states.some((x) => x === 'failed' || x === 'held' || x === 'refused')) return t('data.batchIncomplete')
    return t('data.batchWaiting')
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
    const kept = plan.duplicates.filter((d) => step.keep.has(d.line))
    const total = plan.fresh.length + kept.length
    const confirmImport = (): Promise<void> =>
      run(async () => {
        const out = await onImport({ parsed: step.parsed, signature: plan.signature, keepLines: kept.map((d) => d.line), file: step.file, fingerprint: step.fingerprint })
        if (out.kind === 'changed') {
          setStep((cur) => (cur.kind === 'import' ? withImportPlan(cur, out.plan) : cur))
          return 'stay'
        }
        return 'close'
      })
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
            {step.changed && (
              <p className="draft-note plan-changed" role="status">
                {t('imp.planChanged')}
              </p>
            )}
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
                <Paged items={plan.fresh} first={5} step={SHOWN} className="imp-list" render={rowLine} />
              </section>
            )}

            {plan.duplicates.length > 0 && (
              <section className="imp-section imp-dups">
                <h4>{t('imp.dupsTitle', { n: plan.duplicates.length })}</h4>
                <DuplicatePicker
                  items={plan.duplicates.map((d) => ({ key: String(d.line), line: d.line, file: d.input, here: d.match as Bet }))}
                  keep={new Set([...step.keep].map(String))}
                  oddsFormat={oddsFormat}
                  onChange={(next) => setStep((cur) => (cur.kind === 'import' ? { ...cur, keep: new Set([...next].map(Number)) } : cur))}
                />
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
          {total === 0 && !step.fileProblem && <span className="hint imp-nothing">{t('imp.nothing')}</span>}
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={() => go_menu()}>
            {t('imp.cancel')}
          </button>
          {total > 0 &&
            (running ? (
              <button type="button" className="btn btn-ghost imp-again" disabled={busy} onClick={() => void confirmImport()}>
                {t('imp.againAnyway')}
              </button>
            ) : (
              <button type="button" className="btn btn-primary imp-go" disabled={busy} onClick={() => void confirmImport()}>
                {t('imp.go', { bets: tn('bet', total) })}
              </button>
            ))}
        </footer>
      </div>
    )
  } else if (step.kind === 'restore') {
    const { plan, backup } = step
    const keptDups = plan.duplicateSources.filter((src) => step.keep.has(src)).length
    const addBets = plan.newBets.length + keptDups
    const nothing = addBets === 0 && plan.newMoves.length === 0 && !(replaceSettings && plan.settingsDiffer)
    const confirmRestore = (): Promise<void> =>
      run(async () => {
        const out = await onRestore({ backup, plan, keepSources: [...step.keep], replaceSettings, file: step.file, fingerprint: step.fingerprint })
        if (out.kind === 'changed') {
          setStep((cur) => (cur.kind === 'restore' ? withRestorePlan(cur, out.plan) : cur))
          return 'stay'
        }
        if (out.kind === 'done') setStep({ kind: 'result', batch: out.batch })
        return out.kind === 'done' ? 'stay' : 'close'
      })
    body = (
      <div className="data-step">
        <h3 ref={stepHeadRef} tabIndex={-1}>
          {t('backup.restoreTitle', { file: step.file })}
        </h3>
        <p className="hint">
          {t('backup.from', { email: backup.account.email ?? '—', date: backup.exportedAt ? humanDate(backup.exportedAt.slice(0, 10)) : '—' })}
        </p>
        {step.changed && (
          <p className="draft-note plan-changed" role="status">
            {t('backup.planChanged')}
          </p>
        )}
        <p className="draft-note">{t('backup.onlyAdds')}</p>
        {plan.otherAccount && (
          <p className="draft-note" role="status">
            {t('backup.otherAccount')}
          </p>
        )}
        <ul className="imp-list restore-counts" aria-live="polite">
          <li>{t('backup.betsNew', { n: plan.newBets.length })}</li>
          {plan.duplicateBets.length > 0 && <li>{t('backup.dupsTotal', { n: plan.duplicateBets.length })}</li>}
          {plan.sameBets > 0 && <li>{t('backup.betsSame', { n: plan.sameBets })}</li>}
          {plan.changedBets > 0 && <li>{t('backup.betsChanged', { n: plan.changedBets })}</li>}
          <li>{t('backup.movesNew', { n: plan.newMoves.length })}</li>
          {plan.sameMoves > 0 && <li>{t('backup.movesSame', { n: plan.sameMoves })}</li>}
          {plan.changedMoves > 0 && <li>{t('backup.movesChanged', { n: plan.changedMoves })}</li>}
        </ul>

        {plan.duplicateBets.length > 0 && (
          <section className="imp-section imp-dups">
            <h4>{t('imp.dupsTitle', { n: plan.duplicateBets.length })}</h4>
            <DuplicatePicker
              items={plan.duplicateBets.map((b, i) => ({ key: plan.duplicateSources[i], file: b, here: plan.duplicateOf[i] }))}
              keep={step.keep}
              oddsFormat={oddsFormat}
              onChange={(next) => setStep((cur) => (cur.kind === 'restore' ? { ...cur, keep: next } : cur))}
            />
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
            <Paged
              items={step.bad}
              first={SHOWN}
              step={SHOWN}
              className="imp-list imp-rejected"
              render={(b) => (
                <li key={`${b.kind}${b.index}`}>
                  <span className="imp-line">{t(b.kind === 'bet' ? 'backup.betN' : 'backup.moveN', { n: b.index })}</span> {t(b.key, b.vars)}
                </li>
              )}
            />
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
            <button type="button" className="btn btn-primary restore-go" disabled={busy} onClick={() => void confirmRestore()}>
              {t('backup.restoreGo')}
            </button>
          )}
        </footer>
      </div>
    )
  } else if (step.kind === 'result') {
    const b = batches.find((x) => x.id === step.batch)
    body = b ? (
      <RestoreResult
        batch={b}
        live={live(b)}
        offline={offline}
        headRef={stepHeadRef}
        busy={busy}
        onUndo={() => void run(async () => (await onUndoBatch(b), 'stay'))}
        onSaveAgain={onSaveAgain}
        onRetryRefused={onRetryRefused}
        onPickAgain={() => backupRef.current?.click()}
        onDone={() => go_menu()}
      />
    ) : (
      <div className="data-step" />
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
                      {b.moveIds && b.moveIds.length > 0 ? ` · ${t('data.movesN', { n: b.moveIds.length })}` : ''}
                      {b.restore?.settings ? ` · ${t('data.settingsOnly')}` : ''} · {batchState(b)}
                    </span>
                  </span>
                  <span className="data-batch-actions">
                    {b.kind === 'restore' && (
                      <button type="button" className="btn btn-ghost data-details" onClick={() => go({ kind: 'result', batch: b.id })}>
                        {t('data.details')}
                      </button>
                    )}
                    {!b.undone && (b.kind !== 'restore' || b.stamp) && (
                      <button type="button" className="btn btn-ghost data-undo" onClick={() => void onUndoBatch(b)}>
                        {t(b.kind === 'restore' ? 'data.undoRestore' : 'data.undoImport')}
                      </button>
                    )}
                  </span>
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

  /** The import review with a new plan: the choices kept for duplicates still in it, and the change said. */
  function withImportPlan(cur: Extract<Step, { kind: 'import' }>, plan: ImportPlan): Step {
    const lines = new Set(plan.duplicates.map((d) => d.line))
    return { ...cur, plan, keep: new Set([...cur.keep].filter((l) => lines.has(l))), changed: true }
  }
  function withRestorePlan(cur: Extract<Step, { kind: 'restore' }>, plan: RestorePlan): Step {
    const sources = new Set(plan.duplicateSources)
    return { ...cur, plan, keep: new Set([...cur.keep].filter((x) => sources.has(x))), changed: true }
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

/**
 * What a restore did, part by part, as far as it is known: what the server
 * confirmed it added, what waits on this device to sync (never called added),
 * what was there already, the settings, and anything that failed with what
 * to do about it; then its Undo, and what that did.
 */
function RestoreResult({
  batch,
  live,
  offline,
  headRef,
  busy,
  onUndo,
  onSaveAgain,
  onRetryRefused,
  onPickAgain,
  onDone
}: {
  batch: ImportBatch
  live: BatchLive
  offline: boolean
  headRef: RefObject<HTMLHeadingElement | null>
  busy: boolean
  onUndo: () => void
  onSaveAgain: () => void
  onRetryRefused: () => void
  onPickAgain: () => void
  onDone: () => void
}) {
  const { t, tn } = useLang()
  const st = batchStatus(batch, live)
  const lines = (p: PartStatus, items: (n: number) => string): string[] => {
    switch (p.state) {
      case 'none':
        return [t('result.none')]
      case 'failed':
        return [t('result.failed', { items: items(p.planned) })]
      case 'held':
        return [t('result.held', { items: items(p.waiting) })]
      case 'refused':
        return [t('result.refused', { items: items(p.planned) })]
      case 'waiting':
        return [
          p.made > 0
            ? t('result.partial', { made: p.made, items: items(p.planned), waiting: p.waiting })
            : t(offline ? 'result.waitingOffline' : 'result.waiting', { items: items(p.waiting) })
        ]
      case 'done':
        return [t('result.added', { items: items(p.made) }), p.alreadyThere > 0 ? t('result.alreadyThere', { n: p.alreadyThere }) : '']
    }
  }
  const names = (fields: readonly string[]): string => fields.map((f) => t(`settingName.${f}` as StringKey)).join(', ')
  const settingsLine =
    st.settings.state === 'none'
      ? t('result.settingsNone')
      : st.settings.state === 'failed'
        ? t('result.settingsFailed')
        : st.settings.state === 'held'
          ? t('result.settingsHeld')
          : t(st.settings.state === 'waiting' ? 'result.settingsWaiting' : 'result.settingsDone', { fields: names(st.settings.fields) })
  const states = [st.bets.state, st.moves.state, st.settings.state]
  const held = states.includes('held')
  const refused = states.includes('refused')
  const failed = states.includes('failed')
  const undo = st.undo
  return (
    <div className="data-step restore-result">
      <h3 ref={headRef} tabIndex={-1}>
        {t('result.title', { file: batch.file })}
      </h3>
      <p className="hint">{humanDate(batch.at.slice(0, 10))}</p>
      <dl className="result-parts" aria-live="polite">
        <div className={`result-part is-${st.bets.state} result-bets`}>
          <dt>{t('result.betsLabel')}</dt>
          <dd>
            {lines(st.bets, (n) => tn('bet', n))
              .filter(Boolean)
              .map((l) => (
                <span key={l}>{l} </span>
              ))}
            {st.skipped.bets > 0 && <span>{t('result.skipped', { n: st.skipped.bets })} </span>}
            {st.skipped.duplicates > 0 && <span>{t('result.skippedDups', { n: st.skipped.duplicates })}</span>}
          </dd>
        </div>
        <div className={`result-part is-${st.moves.state} result-moves`}>
          <dt>{t('result.movesLabel')}</dt>
          <dd>
            {lines(st.moves, (n) => tn('move', n))
              .filter(Boolean)
              .map((l) => (
                <span key={l}>{l} </span>
              ))}
            {st.skipped.moves > 0 && <span>{t('result.skipped', { n: st.skipped.moves })}</span>}
          </dd>
        </div>
        <div className={`result-part is-${st.settings.state} result-settings`}>
          <dt>{t('result.settingsLabel')}</dt>
          <dd>{settingsLine}</dd>
        </div>
      </dl>
      {!batch.undone && <p className={`result-overall ${st.complete ? 'is-done' : 'is-waiting'}`}>{t(st.complete ? 'result.complete' : 'result.pending')}</p>}
      {(held || refused || failed) && (
        <div className="result-recover">
          {held && (
            <button type="button" className="btn btn-ghost result-save-again" onClick={onSaveAgain}>
              {t('result.saveAgain')}
            </button>
          )}
          {refused && (
            <button type="button" className="btn btn-ghost result-send-again" onClick={onRetryRefused}>
              {t('result.sendAgain')}
            </button>
          )}
          {failed && (
            <button type="button" className="btn btn-ghost result-pick-again" onClick={onPickAgain}>
              {t('result.pickAgain')}
            </button>
          )}
        </div>
      )}
      <section className="imp-section result-undo">
        <h4>{t('result.undoTitle')}</h4>
        {batch.undone && undo ? (
          <p className="result-undo-state" aria-live="polite">
            {undo.waiting > 0 && <span>{t('result.undoWaiting', { n: undo.waiting })} </span>}
            {undo.removed > 0 && <span>{t('result.undoRemoved', { n: undo.removed })} </span>}
            {undo.kept + undo.changedHere > 0 && <span>{t('result.undoKept', { n: undo.kept + undo.changedHere })} </span>}
            {undo.goneHere > 0 && <span>{t('result.undoGone', { n: undo.goneHere })} </span>}
            {undo.settings && undo.settings.reverted.length > 0 && <span>{t('result.undoSettingsBack', { fields: names(undo.settings.reverted) })} </span>}
            {undo.settings && undo.settings.kept.length > 0 && <span>{t('result.undoSettingsKept', { fields: names(undo.settings.kept) })}</span>}
          </p>
        ) : batch.undone ? (
          <p>{t('data.batchUndone')}</p>
        ) : batch.stamp ? (
          <>
            <p className="hint">{t('result.undoHelp')}</p>
            <button type="button" className="btn btn-ghost result-undo-go" disabled={busy} onClick={onUndo}>
              {t('result.undoGo')}
            </button>
          </>
        ) : (
          <p className="hint">{t('result.undoNA')}</p>
        )}
      </section>
      <footer className="modal-actions">
        <span className="spacer" />
        <button type="button" className="btn btn-primary result-done" onClick={onDone}>
          {t('common.done')}
        </button>
      </footer>
    </div>
  )
}
