import type { SettingsPatch } from '../../../shared/types'
import type { ImportBatch, RestorePart, SettingsField } from '../data/imports'

/**
 * Where an import or a restore stands, from its history entry (what it
 * queued, what the server said it made, what its Undo did) and from the
 * queues as they are now. Every count says only what is known: rows still in
 * a queue are "waiting to sync" (stored on this device, not yet on the
 * server), never "added".
 */
export interface BatchLive {
  /** Rows of the batch still waiting in the bets' queue, and in the moves'. */
  betsQueued: number
  movesQueued: number
  /** A change of the batch the server refused for good (kept in the refused list). */
  refused: boolean
  /** The settings it replaced: still waiting to reach the server. */
  settingsPending: SettingsPatch | null
}

export type PartState = 'none' | 'waiting' | 'done' | 'refused' | 'failed' | 'held'

export interface PartStatus {
  /** Queued by the batch. */
  planned: number
  /** Confirmed by the server as made by it. */
  made: number
  /** Still waiting to sync. */
  waiting: number
  /** Sent, but the server already had that row (another device's, or one restored there): left as it was. */
  alreadyThere: number
  state: PartState
}

export interface BatchStatus {
  bets: PartStatus
  moves: PartStatus
  settings: { fields: SettingsField[]; state: 'none' | 'waiting' | 'done' | 'failed' | 'held' }
  /** Left out by the plan: here already, or possible duplicates the user skipped. */
  skipped: { bets: number; moves: number; duplicates: number }
  /** Nothing of it waits any more, and nothing failed. */
  complete: boolean
  /** The last Undo, if any. */
  undo?: {
    waiting: number
    removed: number
    /** Kept by the server: changed since (on any device), so not removed. */
    kept: number
    /** Left alone here already: changed since, or gone. */
    changedHere: number
    goneHere: number
    settings?: { reverted: SettingsField[]; kept: SettingsField[] }
  }
}

function part(planned: number, made: number, waiting: number, name: RestorePart, b: ImportBatch, refused: boolean): PartStatus {
  if (planned === 0) return { planned, made: 0, waiting: 0, alreadyThere: 0, state: 'none' }
  const failed = b.restore?.failed.includes(name) ?? false
  const held = b.restore?.held.includes(name) ?? false
  const state: PartState = failed ? 'failed' : refused ? 'refused' : waiting > 0 ? (held ? 'held' : 'waiting') : 'done'
  // Once nothing waits, what the server did not make was there already.
  const alreadyThere = state === 'done' ? Math.max(0, planned - made) : 0
  return { planned, made: Math.min(made, planned), waiting, alreadyThere, state }
}

export function batchStatus(b: ImportBatch, live: BatchLive): BatchStatus {
  const madeBets = new Set(b.made ?? [])
  const madeMoves = new Set(b.madeMoves ?? [])
  // An undone batch's rows are not "waiting to be added": what waits is its Undo.
  const undoing = b.undone === true && b.undo !== undefined
  const bets = part(b.ids.length, b.ids.filter((id) => madeBets.has(id)).length, undoing ? 0 : live.betsQueued, 'bets', b, live.refused)
  const moves = part((b.moveIds ?? []).length, (b.moveIds ?? []).filter((id) => madeMoves.has(id)).length, undoing ? 0 : live.movesQueued, 'moves', b, live.refused)

  const s = b.restore?.settings
  const fields = s ? (Object.keys(s.after) as SettingsField[]) : []
  const settingsWaiting = fields.some((f) => live.settingsPending !== null && f in live.settingsPending)
  const settingsState: BatchStatus['settings']['state'] =
    fields.length === 0
      ? 'none'
      : b.restore?.failed.includes('settings')
        ? 'failed'
        : settingsWaiting
          ? b.restore?.held.includes('settings')
            ? 'held'
            : 'waiting'
          : 'done'

  const status: BatchStatus = {
    bets,
    moves,
    settings: { fields, state: settingsState },
    skipped: { bets: b.restore?.skippedBets ?? 0, moves: b.restore?.skippedMoves ?? 0, duplicates: b.restore?.skippedDuplicates ?? 0 },
    complete: [bets.state, moves.state, settingsState].every((x) => x === 'none' || x === 'done')
  }
  if (b.undo) {
    const asked = b.undo.bets.length + b.undo.moves.length
    const answered = b.undo.removed.length + b.undo.kept.length
    status.undo = {
      waiting: Math.max(0, asked - answered),
      removed: b.undo.removed.length,
      kept: b.undo.kept.length,
      changedHere: b.undo.changedHere,
      goneHere: b.undo.goneHere,
      settings: b.undo.settings
    }
  }
  return status
}
