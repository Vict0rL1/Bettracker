import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { describeError } from './errors'
import { insertStamp, type PendingOp } from './offline'
import { readAll } from './readAll'
import type { RowBase, RowStorageSpec } from './rowStorage'
import { signedInUserId } from './session'

/**
 * One simple user-owned table (the expenses, cards and budgets of migration
 * 008), synced the way the moves are (data/moves.ts): ids are made on the
 * device, so a retry after a lost answer meets its own row instead of making
 * a second one; `updated_at` is the device's time of the edit and the
 * conflict key, so an edit lands only if it is the newest; a delete is plain.
 * `createRowTable` makes the requests from a spec of the table's shape.
 */
export interface RowTableSpec<T extends RowBase, I> extends RowStorageSpec<T, I> {
  /** Postgres table. */
  table: 'expenses' | 'expense_cards' | 'expense_budgets'
  /** Realtime channel topic; unique per table (realtime-js reuses a channel per topic). */
  channel: string
  /** readAll order; must end in 'id' so it is unique. */
  order: readonly string[]
  /** A server row (PostgREST JSON: numerics may be strings) as the app's row. Never null: constraints hold on the server. */
  fromRow: (row: Record<string, unknown>) => T
  /** A clean input as the columns written, without id, user_id, created_at and updated_at. */
  toColumns: (clean: I) => Record<string, unknown>
  /** Validate and clean; throws InputError. Run on every add/update before any request. */
  normalize: (input: I) => I
  /** A row back as the input that would write it (an Undo's re-add). */
  toInput: (row: T) => I
  /**
   * Expenses only: a write can be refused for a column the database doesn't have yet while the table reads fine
   * (migration 009 adds three columns that every add and edit names). A read that goes through then says nothing
   * about the queue: only a write that goes through ends the wait (as for the bets and closing_odds).
   */
  columnsMayLag?: boolean
  /** Budgets only: ids come from the content (stableId.ts), so an add can meet a row this device never saw. */
  stableIds?: boolean
  /** Budgets only: the table's other UNIQUE key as [column, value] pairs, to find the row an add collided with under another id. */
  uniqueKey?: (clean: I) => readonly (readonly [string, string])[]
}

export interface RowTable<T extends RowBase, I> {
  readonly spec: RowTableSpec<T, I>
  fetchAll: (asUser?: string) => Promise<T[]>
  /** `createdAt` defaults to `stamp`; `send` passes the op's queuedAt (the optimistic row's createdAt). */
  add: (input: I, id: string, stamp: string, asUser?: string, createdAt?: string) => Promise<T | null>
  update: (id: string, input: I, editedAt: string) => Promise<T | null>
  remove: (id: string, ifStamp?: string) => Promise<T | null>
  send: (op: PendingOp<I>, asUser?: string) => Promise<T | null>
  subscribe: (userId: string, onChange: () => void) => () => void
}

type Row = Record<string, unknown>

export function createRowTable<T extends RowBase, I>(spec: RowTableSpec<T, I>): RowTable<T, I> {
  const from = () => supabase.from(spec.table)

  async function fetchAll(asUser?: string): Promise<T[]> {
    // Without a session the answer would be no rows, not this user's rows.
    await signedInUserId(asUser)
    const rows = await readAll<Row>((first, last) =>
      spec.order.reduce((q, column) => q.order(column, { ascending: true }), from().select('*', { count: 'exact' })).range(first, last)
    )
    return rows.map((r) => spec.fromRow(r))
  }

  /** The row an insert collided with (23505): the one with its id, else (budgets) the one with its other unique key. */
  async function collided(clean: I, id: string): Promise<Row | null> {
    const back = await from().select('*').eq('id', id).maybeSingle()
    // Couldn't tell: the same failure, tried again later.
    if (back.error) throw describeError(back.error, back.status)
    if (back.data) return back.data as Row
    if (!spec.uniqueKey) return null
    const other = await spec.uniqueKey(clean).reduce((q, [column, value]) => q.eq(column, value), from().select('*')).maybeSingle()
    if (other.error) throw describeError(other.error, other.status)
    return (other.data as Row | null) ?? null
  }

  /**
   * Add one row with the id it was given on the device, so a retry after a
   * lost answer is a duplicate rather than a second row. `stamp` is the
   * device time of its content (insertStamp), written as `updated_at`; the
   * device's `created_at` keeps the order of cards (and so their chart inks)
   * the same before and after an offline add syncs. Never an upsert: that
   * could overwrite a newer edit made elsewhere.
   */
  async function add(input: I, id: string, stamp: string, asUser?: string, createdAt?: string): Promise<T | null> {
    const clean = spec.normalize(input) // throws before any request
    const user_id = await signedInUserId(asUser)
    const { data, error, status } = await from()
      .insert({ id, user_id, ...spec.toColumns(clean), created_at: createdAt ?? stamp, updated_at: stamp })
      .select()
    if (error) {
      if (error.code === '23505') {
        const there = await collided(clean, id)
        if (there) {
          // This add is the later edit: applied with the same rule as an
          // update. A resend of this very add finds its own stamp and adopts
          // it; two devices (or tabs) setting the same budget meet on one row
          // holding the later value.
          if (Date.parse(String(there.updated_at)) < Date.parse(stamp)) {
            const later = await from()
              .update({ ...spec.toColumns(clean), updated_at: stamp })
              .eq('id', String(there.id))
              .lte('updated_at', stamp)
              .select()
              .maybeSingle()
            if (later.error) throw describeError(later.error, later.status)
            // Nothing: newer still by now; the refresh after the drain brings it.
            return spec.fromRow((later.data as Row | null) ?? there)
          }
          return spec.fromRow(there)
        }
      }
      throw describeError(error, status)
    }
    // No row: deleted since an earlier attempt made it, and 007 let this one go.
    const rows = (Array.isArray(data) ? data : data ? [data] : []) as Row[]
    return rows.length > 0 ? spec.fromRow(rows[0]) : null
  }

  /** Edit one row: last write wins by when the edit was made. Null when a newer edit already landed or the row is gone. */
  async function update(id: string, input: I, editedAt: string): Promise<T | null> {
    const clean = spec.normalize(input)
    const { data, error, status } = await from()
      .update({ ...spec.toColumns(clean), updated_at: editedAt })
      .eq('id', id)
      .lte('updated_at', editedAt)
      .select()
      .maybeSingle()
    if (error) throw describeError(error, status)
    return data ? spec.fromRow(data as Row) : null
  }

  /** As deleteMove: with `ifStamp`, only the row that still carries that stamp (unused in v1). */
  async function remove(id: string, ifStamp?: string): Promise<T | null> {
    const query = from().delete({ count: 'exact' }).eq('id', id)
    const { error, count, status } = await (ifStamp ? query.eq('updated_at', ifStamp) : query)
    if (error) throw describeError(error, status)
    if (!ifStamp || (count ?? 0) > 0) return null
    const back = await from().select('*').eq('id', id).maybeSingle()
    if (back.error) throw describeError(back.error, back.status)
    return back.data ? spec.fromRow(back.data as Row) : null
  }

  /**
   * One queued op, sent. Resolves with the row the server returned, when
   * there is one. These tables are never imported, so a 'bulk-add' can only
   * be a corrupt queue: it is refused, and the drain drops it.
   */
  async function send(op: PendingOp<I>, asUser?: string): Promise<T | null> {
    // As sendOp: without a session (or `asUser`'s) it waits for the next sign-in.
    await signedInUserId(asUser)
    if (op.kind === 'add') return add(op.input, op.id, insertStamp(op), asUser, op.queuedAt)
    if (op.kind === 'update') return update(op.id, op.input, op.editedAt)
    if (op.kind === 'delete') return remove(op.id, op.ifStamp)
    throw new Error(`${spec.table} rows are never imported`)
  }

  /** Fires `onChange` whenever this user's rows change on any device. Returns an unsubscribe function. */
  function subscribe(userId: string, onChange: () => void): () => void {
    const channel: RealtimeChannel = supabase
      .channel(spec.channel)
      .on('postgres_changes', { event: '*', schema: 'public', table: spec.table, filter: `user_id=eq.${userId}` }, () => onChange())
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }

  return { spec, fetchAll, add, update, remove, send, subscribe }
}
