import { currentUndoSettings, undoOrigin, type ImportBatch, type PartPhase, type SettingsField, type SettingsOutcome } from '../data/imports'
import type { BatchQueued } from '../data/useOpQueue'

/**
 * Where an import, a restore or an Undo stands, from its history entry (each
 * part's phase, and what the server said of each row and setting) and from
 * the queues as they are now. Every count says only what is known: a row the
 * server has said nothing of is never "added" — still in a queue it is
 * waiting to sync; prepared, it is not queued yet (it goes on by itself);
 * neither, it has no answer recorded (Check again asks the server). Nothing
 * is ever read from a queue being empty.
 */
export interface BatchLive {
  /** What the batch still has in the bets' queue and the moves' (adds, and its Undo's removals). */
  bets: BatchQueued
  moves: BatchQueued
  /** Storage refuses that queue: what is in it is in this window only. */
  betsHeld: boolean
  movesHeld: boolean
  /** A change of the batch the server refused for good is in the refused list (it can be sent again). */
  refused: boolean
  /** The operation each pending settings field's write belongs to (see PendingSettings.fieldOrigin). */
  settingsOrigins: Partial<Record<SettingsField, string>>
  /** Storage refuses the pending settings: in this window only. */
  settingsHeld: boolean
}

/**
 * The state of a part, worst first: could not be queued (`failed`), refused
 * for good and still in the refused list (`refused`), written down but not
 * queued yet (`preparing`), queued with no answer and no longer in the queue
 * (`unknown`), in this window's queue only (`held`), in the queue (`waiting`),
 * answered (`done`), nothing to do (`none`).
 */
export type PartState = 'none' | 'failed' | 'refused' | 'preparing' | 'unknown' | 'held' | 'waiting' | 'done'

/** What the user can do about a batch that is not finished. */
export type RecoveryAction = 'resume' | 'check' | 'saveAgain' | 'sendAgain' | 'pickAgain' | 'retrySettings'

export interface PartStatus {
  planned: number
  /** Inserted by this batch, as the server confirmed. */
  made: number
  /** The server already had it (another device's, or restored there): left as it was. */
  present: number
  /** Skipped by the server: deleted on another device since. */
  absent: number
  /** Asked again, the server has no such row (never arrived, or deleted since). */
  missing: number
  rejected: number
  /** The refused ones can still be sent again (they are in the refused list, and the batch is not undone). */
  rejectedOpen: boolean
  /** From before answers were kept (an entry with no stamp): queued then, nothing more is known. */
  untracked: number
  waiting: number
  unknown: number
  preparing: number
  failed: number
  /** Finished with rows that are not on the server (refused and let go, or not there when asked): not plain done. */
  gap: boolean
  state: PartState
}

export interface SettingsStatus {
  fields: SettingsField[]
  confirmed: SettingsField[]
  /** A later change won: not written, or left as it was. */
  kept: SettingsField[]
  rejected: SettingsField[]
  missing: SettingsField[]
  waiting: SettingsField[]
  unknown: SettingsField[]
  preparing: SettingsField[]
  failed: SettingsField[]
  /** Some of it is not on the server (asked again): not plain done. */
  gap: boolean
  reason?: string
  state: PartState
}

export interface UndoStatus {
  asked: number
  removed: number
  /** Kept by the server: changed since (on any device), so not removed. */
  kept: number
  /** Left alone here already: changed since, or gone. */
  changedHere: number
  goneHere: number
  /** Removals refused by the server. */
  failed: number
  /** ...and still in the refused list (they can be sent again). */
  failedOpen: boolean
  waiting: number
  /** The removals waiting are only in this window: storage refused the queue. */
  held: boolean
  unknown: number
  preparing: number
  settings?: SettingsStatus & { keptHere: SettingsField[]; already: SettingsField[] }
  state: PartState
}

export interface BatchStatus {
  bets: PartStatus
  moves: PartStatus
  settings: SettingsStatus
  /** Left out by the plan: here already, or possible duplicates the user skipped. */
  skipped: { bets: number; moves: number; duplicates: number }
  /** Every part has its answers, and nothing failed or was refused. */
  complete: boolean
  /** Finished, but something was skipped by the server (deleted elsewhere) or kept by a later change. */
  skippedLater: boolean
  /** Rows (and settings) that are not on the server and nothing more will happen to: refused and let go, or asked again and not there. */
  notAdded: number
  /** Rows from before answers were kept: what the server did with them is not known. */
  untracked: number
  /** Something of it is on the server (a row made or already there, a setting confirmed). */
  addedAny: boolean
  /** Finished with none of it on the server (all refused, or not there when asked): an Undo has nothing to take back. */
  nothingToUndo: boolean
  actions: RecoveryAction[]
  undo?: UndoStatus
}

const ORDER: PartState[] = ['failed', 'refused', 'preparing', 'unknown', 'held', 'waiting', 'done', 'none']
const worst = (states: readonly PartState[]): PartState => ORDER.find((s) => states.includes(s)) ?? 'none'

/** A part from before parts had phases: as the old record said, else queued. */
function legacyPhase(b: ImportBatch, part: 'bets' | 'moves' | 'settings'): PartPhase {
  if (b.restore?.failed.includes(part)) return 'failed'
  if (b.restore?.held.includes(part)) return 'held'
  return 'queued'
}

function rows(b: ImportBatch, table: 'bets' | 'moves', queued: number, held: boolean, refusedLive: boolean): PartStatus {
  const planned = table === 'bets' ? b.ids : (b.moveIds ?? [])
  const pick = (name: string): Set<string> => new Set(((b as unknown as Record<string, string[] | undefined>)[table === 'bets' ? name : `${name}Moves`] ?? []).filter((id) => planned.includes(id)))
  const made = pick('made')
  const present = pick('present')
  const absent = pick('absent')
  const rejected = pick('rejected')
  const missing = pick('missing')
  const known = new Set([...made, ...present, ...absent, ...rejected, ...missing])
  const open = planned.filter((id) => !known.has(id)).length
  const phase = b.parts?.[table]?.phase ?? legacyPhase(b, table)
  // An undone batch's rows that never got an answer are its Undo's to tell (see UndoStatus).
  const inQueue = Math.min(open, queued)
  const rest = b.undone ? 0 : open - inQueue
  // An entry from before batches had stamps kept no answers, and none can be
  // told now: its rows carry no receipt (see ImportBatch.stamp).
  const legacy = b.stamp === undefined && (phase === 'queued' || phase === 'held')
  const rejectedOpen = refusedLive && !b.undone && rejected.size > 0
  const s: PartStatus = {
    planned: planned.length,
    made: made.size,
    present: present.size,
    absent: absent.size,
    missing: missing.size,
    rejected: rejected.size,
    rejectedOpen,
    untracked: legacy ? rest : 0,
    waiting: inQueue,
    unknown: !legacy && (phase === 'queued' || phase === 'held') ? rest : 0,
    preparing: phase === 'prepared' ? rest : 0,
    failed: phase === 'failed' ? rest : 0,
    gap: missing.size > 0 || (rejected.size > 0 && !rejectedOpen),
    state: 'none'
  }
  if (planned.length === 0) return s
  const states: PartState[] = ['done']
  if (s.failed > 0) states.push('failed')
  // Refused and let go (or the batch undone): settled, said as it is.
  if (s.rejectedOpen) states.push('refused')
  if (s.preparing > 0) states.push('preparing')
  if (s.unknown > 0) states.push('unknown')
  // Held: only while this window's storage refuses its queue (once stored, it waits to sync).
  if (s.waiting > 0) states.push(held ? 'held' : 'waiting')
  return { ...s, state: worst(states) }
}

function settings(
  fields: readonly SettingsField[],
  o: SettingsOutcome & { error?: string },
  origin: string,
  live: BatchLive,
  phase: PartPhase,
  undone: boolean
): SettingsStatus {
  const has = (list: readonly SettingsField[] | undefined, f: SettingsField): boolean => (list ?? []).includes(f)
  const confirmed = fields.filter((f) => has(o.confirmed, f))
  const kept = fields.filter((f) => !has(confirmed, f) && has(o.kept, f))
  const rejected = fields.filter((f) => !has(confirmed, f) && !has(kept, f) && has(o.rejected, f))
  const missing = fields.filter((f) => !has(confirmed, f) && !has(kept, f) && !has(rejected, f) && has(o.missing, f))
  const open = fields.filter((f) => ![confirmed, kept, rejected, missing].some((l) => has(l, f)))
  const waiting = open.filter((f) => live.settingsOrigins[f] === origin)
  const rest = undone ? [] : open.filter((f) => !waiting.includes(f))
  const s: SettingsStatus = {
    fields: [...fields],
    confirmed,
    kept,
    rejected,
    missing,
    waiting,
    unknown: phase === 'queued' || phase === 'held' ? rest : [],
    preparing: phase === 'prepared' ? rest : [],
    failed: phase === 'failed' ? rest : [],
    gap: missing.length > 0,
    ...(o.reason ? { reason: o.reason } : o.error ? { reason: o.error } : {}),
    state: 'none'
  }
  if (fields.length === 0) return s
  const states: PartState[] = ['done']
  // Not on the server when asked again: a fact (trying again is offered), not a part left to finish.
  if (s.failed.length > 0) states.push('failed')
  if (s.rejected.length > 0) states.push('refused')
  if (s.preparing.length > 0) states.push('preparing')
  if (s.unknown.length > 0) states.push('unknown')
  if (s.waiting.length > 0) states.push(live.settingsHeld ? 'held' : 'waiting')
  return { ...s, state: worst(states) }
}

function undoStatus(b: ImportBatch, live: BatchLive): UndoStatus | undefined {
  const u = b.undo
  if (!u) return undefined
  const asked = [...u.bets, ...u.moves]
  const answered = new Set([...u.removed, ...u.kept, ...(u.failed ?? [])])
  const open = asked.filter((id) => !answered.has(id)).length
  const inQueue = Math.min(open, live.bets.removals + live.moves.removals)
  const phase = u.phase ?? 'queued'
  const rest = open - inQueue
  const s: UndoStatus = {
    asked: asked.length,
    removed: u.removed.length,
    kept: u.kept.length,
    changedHere: u.changedHere,
    goneHere: u.goneHere,
    failed: (u.failed ?? []).length,
    failedOpen: live.refused && (u.failed ?? []).length > 0,
    waiting: inQueue,
    held: inQueue > 0 && (live.betsHeld || live.movesHeld),
    unknown: phase === 'prepared' ? 0 : rest,
    preparing: phase === 'prepared' ? rest : 0,
    state: 'none'
  }
  const states: PartState[] = asked.length > 0 ? ['done'] : []
  if (s.failedOpen) states.push('refused')
  if (s.preparing > 0) states.push('preparing')
  if (s.unknown > 0) states.push('unknown')
  if (s.waiting > 0) states.push(s.held ? 'held' : 'waiting')
  if (u.settings) {
    // From before outcomes were recorded, `reverted` and `kept` (left here): read as now (see currentUndoSettings).
    const us = currentUndoSettings(u.settings)
    const st = settings(us.asked ?? [], us, undoOrigin(b.id), live, us.phase ?? phase, false)
    s.settings = { ...st, keptHere: us.keptHere ?? [], already: us.already ?? [] }
    if (st.state !== 'none') states.push(st.state)
  }
  return { ...s, state: worst(states) }
}

export function batchStatus(b: ImportBatch, live: BatchLive): BatchStatus {
  const undone = b.undone === true && b.undo !== undefined
  // Undone: what it added still in the queue waits (its Undo removes them after); nothing else is asked of it.
  const bets = rows(b, 'bets', live.bets.adds, live.betsHeld, live.refused)
  const moves = rows(b, 'moves', live.moves.adds, live.movesHeld, live.refused)
  const r = b.restore?.settings
  const settingsPart = settings(
    r ? (Object.keys(r.after) as SettingsField[]) : [],
    r ?? {},
    b.id,
    live,
    r?.phase ?? legacyPhase(b, 'settings'),
    undone
  )
  const states = [bets.state, moves.state, settingsPart.state]
  const complete = states.every((x) => x === 'none' || x === 'done')
  const undo = undoStatus(b, live)
  // Undone: only its Undo can still need something (the batch's own parts are no longer wanted:
  // sending them again, or writing their settings, would put back what the Undo took out).
  const own = undone ? [] : states
  const watched = [...own, ...(undo ? [undo.state] : [])]
  const actions: RecoveryAction[] = []
  if (watched.includes('preparing')) actions.push('resume')
  // Not there when asked, or no answer: the server can be asked (again).
  if (watched.includes('unknown') || (!undone && bets.missing + moves.missing > 0)) actions.push('check')
  if (watched.includes('held')) actions.push('saveAgain')
  if (bets.rejectedOpen || moves.rejectedOpen || undo?.failedOpen) actions.push('sendAgain')
  // Could not be queued, or not on the server when asked again: picking the file again adds what is missing.
  if (!undone && bets.failed + moves.failed + bets.missing + moves.missing > 0) actions.push('pickAgain')
  if (
    (!undone && settingsPart.rejected.length + settingsPart.failed.length + settingsPart.missing.length > 0) ||
    (undo?.settings && undo.settings.rejected.length + undo.settings.failed.length + undo.settings.missing.length > 0)
  )
    actions.push('retrySettings')
  const there = bets.made + bets.present + moves.made + moves.present + settingsPart.confirmed.length
  const notThere = bets.missing + moves.missing + (bets.rejectedOpen ? 0 : bets.rejected) + (moves.rejectedOpen ? 0 : moves.rejected) + settingsPart.missing.length
  return {
    bets,
    moves,
    settings: settingsPart,
    skipped: { bets: b.restore?.skippedBets ?? 0, moves: b.restore?.skippedMoves ?? 0, duplicates: b.restore?.skippedDuplicates ?? 0 },
    complete,
    skippedLater: complete && (bets.absent + moves.absent > 0 || settingsPart.kept.length > 0),
    notAdded: undone ? 0 : notThere,
    untracked: bets.untracked + moves.untracked,
    addedAny: there > 0,
    nothingToUndo: !undone && complete && bets.untracked + moves.untracked === 0 && there === 0 && notThere > 0,
    actions,
    ...(undo ? { undo } : {})
  }
}
