import { readdStamp, type PendingOp } from './offline'
import type { RowBase } from './rowStorage'
import type { RowTableSpec } from './rowTable'

/**
 * What the row hooks (data/useRowSync.ts) queue, and what an answer to one
 * tells the user. Decided here, without React, so that every branch is
 * tested (rowOps.test.ts); the hook only queues what these build.
 */

export type RowAddOp<I> = Extract<PendingOp<I>, { kind: 'add' }>

/**
 * One add, checked first: a bad input throws (InputError) and nothing is
 * queued. The id is made here unless given (a budget's comes from what it
 * is, see lib/stableId.ts). `after`: the updatedAt of the last row this device
 * knew under that id (a budget set again after it was cleared); the add is
 * stamped just past it, so 007's tombstone of that row can't swallow it.
 */
export function addOp<I>(normalize: (input: I) => I, input: I, opts: { id?: string; after?: string }, newId: () => string, now: Date = new Date()): RowAddOp<I> {
  const clean = normalize(input)
  const id = opts.id ?? newId()
  const queuedAt = opts.after ? readdStamp([{ updatedAt: opts.after }], now) : now.toISOString()
  return { opId: newId(), kind: 'add', id, input: clean, queuedAt }
}

/** Several adds (an AI scan's rows): every input checked before any op is built, so none is queued if one fails; one stamp. */
export function addManyOps<I>(normalize: (input: I) => I, inputs: readonly I[], newId: () => string, now: Date = new Date()): RowAddOp<I>[] {
  const clean = inputs.map((i) => normalize(i))
  const queuedAt = now.toISOString()
  return clean.map((input) => ({ opId: newId(), kind: 'add', id: newId(), input, queuedAt }))
}

/**
 * The Undo of a delete: the row added again under its own id, with what it
 * held. Its content is stamped just past the row's own stamp (readdStamp), so
 * 007's tombstone of the delete lets it in. It keeps the time it was made
 * (`queuedAt`, which the insert writes as created_at, see rowTable.send), so
 * it comes back to its place: a card to its place among the cards, and so to
 * its ink, an expense to its place in its day.
 */
export function restoreOp<T extends RowBase, I>(spec: Pick<RowTableSpec<T, I>, 'normalize' | 'toInput'>, row: T, newId: () => string, now: Date = new Date()): RowAddOp<I> {
  const stamp = readdStamp([row], now)
  // A cached row without a readable createdAt: made now.
  const made = Number.isFinite(Date.parse(row.createdAt)) ? row.createdAt : stamp
  return { opId: newId(), kind: 'add', id: row.id, input: spec.normalize(spec.toInput(row)), queuedAt: made, editedAt: stamp }
}

/**
 * What the server's answer to an op tells the user:
 *  - an edit answered with no row: a newer edit elsewhere won, or the row is
 *    gone. Said, unless a later change of this device to the same row is
 *    still queued (`superseded`, see useBetSync);
 *  - an add of a table whose ids come from the content (a budget set again)
 *    let go by 007: its row was cleared later elsewhere, or a clock ran
 *    ahead. Said, never silent;
 *  - anything else: nothing.
 */
export function answerNotice<I>(op: PendingOp<I>, row: unknown, superseded: boolean, stableIds: boolean): 'conflict' | null {
  if (op.kind === 'update' && row === null && !superseded) return 'conflict'
  if (stableIds && op.kind === 'add' && row === null) return 'conflict'
  return null
}
