import type { SettingsPatch } from '../../../shared/types'
import {
  answeredAny,
  foldBatchEvent,
  prepare,
  unanswered,
  withOperation,
  type BetPayload,
  type ImportBatch,
  type MovePayload,
  type PartPhase,
  type SettingsField,
  type SettingsOutcome,
  type UndoLog,
  undoOrigin
} from './imports'
import { fieldTime, pendingWrite, type MoveOp, type PendingOp, type PendingSettings } from './offline'
import { addsQueued, removalsQueued } from './useOpQueue'

/**
 * Imports, restores and Undos as operations that outlive the window that
 * started them.
 *
 * An operation is written down first (data/imports.ts), each of its parts
 * `prepared` with what it is to queue. Then each part is queued and marked
 * `queued` (or `held`, when storage refused the queue and only this window
 * has it, or `failed`, when it could not be queued at all). A window that
 * closes or reloads between the two leaves the part prepared: the next
 * window to start (or this one, every little while) queues it, once.
 *
 * Once means: one window at a time works on an operation (its lock, see
 * withOperation); and a part is not queued again when the queue already holds
 * it (that generation of it: the mark was lost after it was queued) or when
 * the server has already answered for it (it was queued, sent, and is out of
 * the queue). Nothing is ever taken to be done because the queue is empty:
 * only what the server said counts (see lib/batchStatus.ts).
 */
export type OperationPart = 'bets' | 'moves' | 'settings' | 'undo' | 'undoSettings'

/** What an operation needs of the app: the history, the queues and the settings. */
export interface OperationPorts {
  userId: string
  /** Still this user's window (an account changed meanwhile: nothing more is queued). */
  active: () => boolean
  history: {
    fresh: () => Promise<ImportBatch[]>
    change: (id: string, fn: (b: ImportBatch) => ImportBatch) => Promise<ImportBatch[]>
  }
  bets: {
    queue: () => Promise<readonly PendingOp<unknown>[]>
    /** Queue the rows of a batch (unless that generation of it is queued already). */
    add: (payload: readonly BetPayload[], o: { batch: string; stamp: string }) => Promise<{ saved: boolean; queued: boolean }>
    /** Queue an Undo's removals, each asked about the stamp given. */
    remove: (targets: readonly { id: string; stamp: string }[], batch: string) => Promise<{ saved: boolean }>
  }
  moves: {
    queue: () => Promise<readonly MoveOp[] | readonly PendingOp<unknown>[]>
    add: (payload: readonly MovePayload[], o: { batch: string; stamp: string }) => Promise<{ saved: boolean; queued: boolean }>
    remove: (targets: readonly { id: string; stamp: string }[], batch: string) => Promise<{ saved: boolean }>
  }
  settings: {
    pending: () => Promise<PendingSettings | null>
    /** Pending once written: true when storage holds it (see useSettings.update). */
    write: (patch: SettingsPatch, o: { origin: string; editedAt: string; guard?: SettingsPatch; once: true }) => Promise<boolean>
  }
  /** The history as it is now, to show. */
  shown?: (list: ImportBatch[]) => void
}

export function openFields(o: { confirmed?: SettingsField[]; kept?: SettingsField[] } | undefined, fields: readonly SettingsField[]): SettingsField[] {
  return fields.filter((f) => !(o?.confirmed ?? []).includes(f) && !(o?.kept ?? []).includes(f))
}

/** What was known of a restore's settings, but for `fields` (to be written again): their answers go. */
export function withoutFields(s: SettingsOutcome, fields: readonly SettingsField[]): SettingsOutcome {
  const drop = (l: SettingsField[] | undefined): SettingsField[] | undefined => l?.filter((f) => !fields.includes(f))
  const rejected = drop(s.rejected)
  return {
    confirmed: drop(s.confirmed) ?? [],
    kept: drop(s.kept) ?? [],
    ...(rejected && rejected.length > 0 ? { rejected, ...(s.reason ? { reason: s.reason } : {}) } : {}),
    ...(drop(s.missing)?.length ? { missing: drop(s.missing) } : {})
  }
}

/**
 * A field the Undo left alone (changed since, here or elsewhere) and that has
 * no answer: kept, as the Undo said. Left open, it would be asked about again
 * and could look as if it never arrived. One that already held the value from
 * before (see undoSettingsPlan) stays open: there was no later change.
 */
function keptUnlessAnswered(o: SettingsOutcome, fields: readonly SettingsField[], reverted: readonly SettingsField[], already: readonly SettingsField[]): SettingsOutcome {
  const known = new Set([...(o.confirmed ?? []), ...(o.kept ?? []), ...(o.rejected ?? []), ...(o.missing ?? [])])
  const left = fields.filter((f) => !reverted.includes(f) && !known.has(f) && !already.includes(f))
  return left.length > 0 ? { ...o, kept: [...(o.kept ?? []), ...left] } : o
}

/** Equal as settings: numbers within a cent (the server rounds), anything else exactly. */
export const sameSetting = (a: unknown, b: unknown): boolean =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 0.005 : Object.is(a ?? null, b ?? null)

/**
 * Check again, for settings with no answer: what the server's row says of
 * each, field by field, and nothing more. A restore's field holding the
 * backup's value is there (confirmed); holding neither the backup's nor the
 * old one, someone changed it (kept); still holding the old one, the backup's
 * value is not on the server (missing). Whether it never arrived or was set
 * back since can not be told (the row has one time for all its fields): it is
 * said as it is, and trying again is offered, never done by itself. An Undo
 * the same way round: the old value is back (confirmed), the backup's is
 * still there (missing: not put back), anything else someone chose (kept).
 * No row: the defaults.
 */
export function checkSettings(
  s: { before: SettingsPatch; after: SettingsPatch },
  row: Partial<Record<SettingsField, unknown>> | null,
  fields: readonly SettingsField[],
  undo: boolean,
  defaults: Partial<Record<SettingsField, unknown>>
): { confirmed: SettingsField[]; kept: SettingsField[]; missing: SettingsField[] } {
  const value = (f: SettingsField): unknown => (row ? row[f] : defaults[f])
  const out = { confirmed: [] as SettingsField[], kept: [] as SettingsField[], missing: [] as SettingsField[] }
  for (const f of fields) {
    const v = value(f)
    if (undo) (sameSetting(v, s.before[f]) ? out.confirmed : sameSetting(v, s.after[f]) ? out.missing : out.kept).push(f)
    else if (sameSetting(v, s.after[f])) out.confirmed.push(f)
    else if (!sameSetting(v, s.before[f])) out.kept.push(f)
    else out.missing.push(f)
  }
  return out
}

/**
 * A batch's Undo undone (from the Undo's message): what the Undo removed goes
 * back, written down again under a new `stamp` (the next Undo takes it by
 * that, see readdStamp), and the settings it put back go forward again, only
 * where they still hold what it put back. Nothing else is written again: a
 * field the Undo left alone keeps what was known of it.
 */
export function redoBatch(
  b: ImportBatch,
  r: { stamp: string; now: string; bets: readonly BetPayload[]; moves: readonly MovePayload[]; reverted: readonly SettingsField[] }
): ImportBatch {
  const s = b.restore?.settings
  return {
    ...b,
    undone: false,
    stamp: r.stamp,
    ids: r.bets.map((p) => p.id),
    moveIds: r.moves.map((p) => p.id),
    made: [],
    madeMoves: [],
    present: undefined,
    presentMoves: undefined,
    absent: undefined,
    absentMoves: undefined,
    rejected: undefined,
    rejectedMoves: undefined,
    missing: undefined,
    missingMoves: undefined,
    parts: {
      ...(r.bets.length > 0 ? { bets: { phase: 'prepared' as const, payload: [...r.bets] } } : {}),
      ...(r.moves.length > 0 ? { moves: { phase: 'prepared' as const, payload: [...r.moves] } } : {})
    },
    ...(b.restore && s && r.reverted.length > 0
      ? {
          restore: {
            ...b.restore,
            settings: {
              before: s.before,
              after: s.after,
              editedAt: r.now,
              guard: s.before,
              write: [...r.reverted],
              phase: 'prepared' as const,
              ...keptUnlessAnswered(withoutFields(s, r.reverted), Object.keys(s.after) as SettingsField[], r.reverted, b.undo?.settings?.already ?? [])
            }
          }
        }
      : {}),
    undo: undefined
  }
}

/**
 * Try again the settings that the server refused, that could not be queued,
 * or that it does not hold: written `now`, only those, and only where the
 * server still holds what was there before (a change made since stays). An
 * undone batch's own settings are no longer wanted: only its Undo's, which
 * go only where the server still holds the restore's values.
 */
export function retrySettingsOf(x: ImportBatch, now: string): ImportBatch {
  let next = x
  const s = x.restore?.settings
  if (s && x.restore && !x.undone) {
    const failed = s.phase === 'failed' || (s.phase === undefined && x.restore.failed.includes('settings'))
    const again = [...new Set([...(s.rejected ?? []), ...(s.missing ?? []), ...(failed ? openFields(s, Object.keys(s.after) as SettingsField[]) : [])])]
    if (again.length > 0) {
      const { rejected: _r, missing: _m, reason: _why, error: _e, ...rest } = s
      next = { ...next, restore: { ...x.restore, settings: { ...rest, editedAt: now, guard: s.before, write: again, phase: 'prepared' } } }
    }
  }
  const us = x.undo?.settings
  if (us && x.undo && ((us.rejected ?? []).length > 0 || (us.missing ?? []).length > 0 || us.phase === 'failed')) {
    const { rejected: _r, missing: _m, reason: _why, error: _e, ...rest } = us
    next = { ...next, undo: { ...x.undo, settings: { ...rest, editedAt: now, phase: 'prepared' } } }
  }
  return next
}

/**
 * What an Undo does with each of a restore's settings, from the values here:
 * still the backup's, put back (`reverted`); holding the value from before
 * when it was never confirmed as replaced (it may never have arrived), nothing
 * to put back and no later change to speak of (`already`); anything else, a
 * later change, kept (`keptHere`).
 */
export function undoSettingsPlan(
  s: { before: SettingsPatch; after: SettingsPatch; confirmed?: SettingsField[] },
  current: Partial<Record<SettingsField, unknown>>
): { reverted: SettingsField[]; keptHere: SettingsField[]; already: SettingsField[] } {
  const fields = Object.keys(s.after) as SettingsField[]
  const reverted = fields.filter((f) => sameSetting(current[f], s.after[f]))
  const already = fields.filter((f) => !reverted.includes(f) && sameSetting(current[f], s.before[f]) && !(s.confirmed ?? []).includes(f))
  return { reverted, keptHere: fields.filter((f) => !reverted.includes(f) && !already.includes(f)), already }
}

/**
 * The settings part of an Undo of a restore, as App.undoBatch writes it down:
 * what it asks to put back (prepared, to be queued), what it leaves because
 * it changed since, and what already had the value from before (see
 * undoSettingsPlan). Nothing when the restore set no settings.
 */
export function undoSettingsLog(
  replaced: { before: SettingsPatch; after: SettingsPatch; confirmed?: SettingsField[] } | undefined,
  current: Partial<Record<SettingsField, unknown>>,
  at: string
): { reverted: SettingsField[]; keptHere: SettingsField[]; already: SettingsField[]; settings?: NonNullable<UndoLog['settings']> } {
  if (!replaced || Object.keys(replaced.after).length === 0) return { reverted: [], keptHere: [], already: [] }
  const plan = undoSettingsPlan(replaced, current)
  return {
    ...plan,
    settings: {
      asked: plan.reverted,
      keptHere: plan.keptHere,
      ...(plan.already.length > 0 ? { already: plan.already } : {}),
      editedAt: at,
      phase: plan.reverted.length > 0 ? 'prepared' : 'queued'
    }
  }
}

/** The parts of an operation still to queue. */
export function preparedParts(b: ImportBatch): OperationPart[] {
  const out: OperationPart[] = []
  if (b.parts?.bets?.phase === 'prepared') out.push('bets')
  if (b.parts?.moves?.phase === 'prepared') out.push('moves')
  if (b.restore?.settings?.phase === 'prepared') out.push('settings')
  if (b.undo?.phase === 'prepared') out.push('undo')
  if (b.undo?.settings?.phase === 'prepared') out.push('undoSettings')
  return out
}

function phaseOf(b: ImportBatch, part: OperationPart): PartPhase | undefined {
  switch (part) {
    case 'bets':
      return b.parts?.bets?.phase
    case 'moves':
      return b.parts?.moves?.phase
    case 'settings':
      return b.restore?.settings?.phase
    case 'undo':
      return b.undo?.phase
    case 'undoSettings':
      return b.undo?.settings?.phase
  }
}

/** The part at `phase` (its payload goes once it is no longer prepared: the queue has it). */
function withPhase(b: ImportBatch, part: OperationPart, phase: PartPhase, error?: string): ImportBatch {
  const err = error ? { error } : {}
  switch (part) {
    case 'bets': {
      const cur = b.parts?.bets
      if (!cur) return b
      return { ...b, parts: { ...b.parts, bets: phase === 'prepared' ? { ...cur, phase } : { phase, ...err } } }
    }
    case 'moves': {
      const cur = b.parts?.moves
      if (!cur) return b
      return { ...b, parts: { ...b.parts, moves: phase === 'prepared' ? { ...cur, phase } : { phase, ...err } } }
    }
    case 'settings':
      return b.restore?.settings ? { ...b, restore: { ...b.restore, settings: { ...b.restore.settings, phase, ...err } } } : b
    case 'undo':
      return b.undo ? { ...b, undo: { ...b.undo, phase, ...err } } : b
    case 'undoSettings':
      return b.undo?.settings ? { ...b, undo: { ...b.undo, settings: { ...b.undo.settings, phase, ...err } } } : b
  }
}

async function find(ports: OperationPorts, id: string): Promise<ImportBatch | undefined> {
  return (await ports.history.fresh()).find((b) => b.id === id)
}

async function mark(ports: OperationPorts, id: string, part: OperationPart, phase: PartPhase, error?: string): Promise<void> {
  const list = await ports.history.change(id, (b) => (phaseOf(b, part) === 'prepared' ? withPhase(b, part, phase, error) : b))
  ports.shown?.(list)
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const pick = (p: SettingsPatch | undefined, keys: readonly SettingsField[]): SettingsPatch =>
  Object.fromEntries(keys.map((k) => [k, (p as Record<string, unknown> | undefined)?.[k] ?? null])) as SettingsPatch

/** The Undo's rows of `table` still to remove, with the stamp each is removed by. */
function undoTargets(b: ImportBatch, table: 'bets' | 'moves'): { id: string; stamp: string }[] {
  const u = b.undo
  if (!u) return []
  const answered = new Set([...u.removed, ...u.kept, ...(u.failed ?? [])])
  return (table === 'bets' ? u.bets : u.moves).filter((id) => !answered.has(id)).map((id) => ({ id, stamp: u.stamps?.[id] ?? u.stamp }))
}

/**
 * Queue one part of operation `id` if it is still `prepared`, and mark it.
 * The caller holds the operation's lock (see withOperation).
 */
export async function queuePart(ports: OperationPorts, id: string, part: OperationPart): Promise<void> {
  const entry = await find(ports, id)
  if (!entry || phaseOf(entry, part) !== 'prepared' || !ports.active()) return
  try {
    switch (part) {
      case 'bets':
      case 'moves': {
        const queue = part === 'bets' ? ports.bets.queue : ports.moves.queue
        const stamp = entry.stamp ?? entry.at
        // Queued already (the mark was lost), or answered for (queued, sent, and gone from the queue).
        if (addsQueued(await queue(), id, stamp)) return await mark(ports, id, part, 'queued')
        const now = await find(ports, id)
        if (!now || phaseOf(now, part) !== 'prepared' || (now.stamp ?? now.at) !== stamp) return
        if (answeredAny(now, part)) return await mark(ports, id, part, 'queued')
        const left = new Set(unanswered(now, part))
        if (!ports.active()) return
        const r =
          part === 'bets'
            ? await ports.bets.add((now.parts?.bets?.payload ?? []).filter((p) => left.has(p.id)), { batch: id, stamp })
            : await ports.moves.add((now.parts?.moves?.payload ?? []).filter((p) => left.has(p.id)), { batch: id, stamp })
        return await mark(ports, id, part, r.saved ? 'queued' : 'held')
      }
      case 'settings':
      case 'undoSettings': {
        const origin = part === 'settings' ? id : undoOrigin(id)
        const pending = await ports.settings.pending()
        // This very write pending already (its operation, its time): only the mark was lost.
        const writtenAt = part === 'settings' ? entry.restore?.settings?.editedAt : (entry.undo?.settings?.editedAt ?? entry.undo?.at)
        if (writtenAt !== undefined && pendingWrite(pending, origin, writtenAt)) return await mark(ports, id, part, 'queued')
        const now = await find(ports, id)
        if (!now || phaseOf(now, part) !== 'prepared' || !ports.active()) return
        // A guarded write (tried again, put forward again, an Undo) leaves a
        // field alone that has a change of its own pending here — the user's,
        // or another operation's — and says it was kept: like a change already
        // on the server, the guard would not see it until it is sent.
        const ours = new Set([id, undoOrigin(id)])
        const foreign = (fields: readonly SettingsField[]): SettingsField[] =>
          fields.filter((f) => pending !== null && f in pending.patch && !ours.has(pending.fieldOrigin?.[f] ?? ''))
        const keep = async (fields: readonly SettingsField[], editedAt: string | undefined): Promise<void> => {
          if (fields.length === 0) return
          const list = await ports.history.change(id, (b) =>
            foldBatchEvent([b], { kind: 'settings', batch: id, undo: part === 'undoSettings', ...(editedAt ? { editedAt } : {}), kept: [...fields] })[0]
          )
          ports.shown?.(list)
        }
        if (part === 'settings') {
          const s = now.restore?.settings
          if (!s) return
          // Undone meanwhile: what it would write is no longer wanted.
          if (now.undone) return await mark(ports, id, part, 'queued')
          const open = openFields(s, Object.keys(s.after) as SettingsField[]).filter((f) => !(s.rejected ?? []).includes(f) && (!s.write || s.write.includes(f)))
          // Guarded: any change of its own pending keeps a field. Not guarded: a newer one does
          // (the write, made earlier, would lose to it field by field: see editSettings).
          const taken = foreign(open).filter((f) => s.guard !== undefined || (pending !== null && fieldTime(pending, f) > s.editedAt))
          await keep(taken, s.editedAt)
          const fields = open.filter((f) => !taken.includes(f))
          if (fields.length === 0) return await mark(ports, id, part, 'queued')
          const saved = await ports.settings.write(pick(s.after, fields), { origin, editedAt: s.editedAt, ...(s.guard ? { guard: pick(s.guard, fields) } : {}), once: true })
          return await mark(ports, id, part, saved ? 'queued' : 'held')
        }
        const s = now.undo?.settings
        const before = now.restore?.settings?.before
        const after = now.restore?.settings?.after
        if (!s || !before || !after) return
        const editedAt = s.editedAt ?? now.undo?.at ?? new Date().toISOString()
        const open = openFields(s, s.asked ?? []).filter((f) => !(s.rejected ?? []).includes(f))
        const taken = foreign(open)
        await keep(taken, editedAt)
        const fields = open.filter((f) => !taken.includes(f))
        if (fields.length === 0) return await mark(ports, id, part, 'queued')
        const saved = await ports.settings.write(pick(before, fields), { origin, editedAt, guard: pick(after, fields), once: true })
        return await mark(ports, id, part, saved ? 'queued' : 'held')
      }
      case 'undo': {
        // Each table on its own: a reload between the two leaves one queued.
        let saved = true
        for (const table of ['bets', 'moves'] as const) {
          const targets = undoTargets(entry, table)
          if (targets.length === 0) continue
          const port = table === 'bets' ? ports.bets : ports.moves
          if (removalsQueued(await port.queue(), id, targets)) continue
          const now = await find(ports, id)
          if (!now?.undo || now.undo.phase !== 'prepared' || !ports.active()) return
          const left = undoTargets(now, table)
          if (left.length === 0) continue
          saved = (await port.remove(left, id)).saved && saved
        }
        return await mark(ports, id, part, saved ? 'queued' : 'held')
      }
    }
  } catch (err) {
    // A row that can't be queued at all: the part stops here, and says why.
    await mark(ports, id, part, 'failed', message(err))
  }
}

/** Queue every part of operation `id` still prepared, in order. The caller holds its lock. */
export async function queueParts(ports: OperationPorts, id: string): Promise<void> {
  for (const part of ['bets', 'moves', 'settings', 'undo', 'undoSettings'] as const) await queuePart(ports, id, part)
}

/**
 * Start an operation: written down (HistoryFullError when that can't be
 * stored: nothing is queued), then queued. Resolves with its entry as it is then.
 */
export async function startOperation(ports: OperationPorts, batch: ImportBatch): Promise<ImportBatch | undefined> {
  const list = await prepare(ports.userId, batch)
  ports.shown?.(list)
  await withOperation(ports.userId, batch.id, () => queueParts(ports, batch.id))
  return find(ports, batch.id)
}

/** Change an operation (an Undo, a retry, its Undo undone) and queue what that prepared. */
export async function continueOperation(ports: OperationPorts, id: string, fn: (b: ImportBatch) => ImportBatch): Promise<ImportBatch | undefined> {
  return withOperation(ports.userId, id, async () => {
    const list = await ports.history.change(id, fn)
    ports.shown?.(list)
    await queueParts(ports, id)
    return find(ports, id)
  })
}

/**
 * Queue what any operation of this user left prepared (a window closed or
 * reloaded before it queued it): at start, and every little while. An
 * operation another window is working on now is left to it.
 */
export async function resumeOperations(ports: OperationPorts): Promise<void> {
  const list = await ports.history.fresh()
  for (const b of list) {
    if (!ports.active()) return
    if (preparedParts(b).length === 0) continue
    await withOperation(ports.userId, b.id, () => queueParts(ports, b.id), { ifFree: true })
  }
}
