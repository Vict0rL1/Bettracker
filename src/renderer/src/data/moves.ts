import type { RealtimeChannel } from '@supabase/supabase-js'
import type { BankrollMove, MoveInput } from '../../../shared/types'
import { supabase } from '../lib/supabase'
import { normalizeMove } from '../lib/validate'
import { describeError } from './errors'
import { insertStamp, type MoveOp } from './offline'

// Deposits and withdrawals (migration 005). Same rules as the bets: ids are
// made on the device, and an edit lands only if it is the newest.
const TABLE = 'bankroll_moves'

interface Row {
  id: string
  date: string
  amount: number | string
  note: string | null
  created_at: string
  updated_at: string
}

// PostgREST returns numeric columns as strings to preserve precision — coerce.
function toMove(row: Row): BankrollMove {
  return {
    id: row.id,
    date: row.date,
    amount: Number(row.amount),
    note: row.note ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

async function currentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  const id = data.session?.user?.id
  if (!id) throw new Error('You are signed out — sign in to sync your deposits and withdrawals')
  return id
}

export async function getMoves(): Promise<BankrollMove[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .order('date', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw describeError(error)
  return (data as Row[]).map(toMove)
}

/**
 * Add one move with the id it was given on the device, so a retry after a
 * lost answer is a duplicate rather than a second deposit. `stamp` is the
 * device time of its content (insertStamp), written as `updated_at` for the
 * same reason as addBet's.
 */
export async function addMove(input: MoveInput, id: string, stamp: string): Promise<BankrollMove> {
  const clean = normalizeMove(input)
  const user_id = await currentUserId()
  const { data, error } = await supabase
    .from(TABLE)
    .insert({ id, user_id, date: clean.date, amount: clean.amount, note: clean.note, updated_at: stamp })
    .select()
    .single()
  if (error) {
    if (error.code === '23505') {
      // Already inserted by an earlier attempt whose response we never saw.
      // Never an upsert: that could overwrite a newer edit made elsewhere.
      const { data: existing } = await supabase.from(TABLE).select('*').eq('id', id).single()
      if (existing) return toMove(existing as Row)
    }
    throw describeError(error)
  }
  return toMove(data as Row)
}

/**
 * Edit one move — last write wins by when the edit was made, exactly as
 * updateBet. Returns null when a newer edit already landed or the move is
 * gone.
 */
export async function updateMove(id: string, input: MoveInput, editedAt: string): Promise<BankrollMove | null> {
  const clean = normalizeMove(input)
  const { data, error } = await supabase
    .from(TABLE)
    .update({ date: clean.date, amount: clean.amount, note: clean.note, updated_at: editedAt })
    .eq('id', id)
    .lte('updated_at', editedAt)
    .select()
    .maybeSingle()
  if (error) throw describeError(error)
  return data ? toMove(data as Row) : null
}

export async function deleteMove(id: string): Promise<boolean> {
  const { error, count } = await supabase.from(TABLE).delete({ count: 'exact' }).eq('id', id)
  if (error) throw describeError(error)
  return (count ?? 0) > 0
}

/**
 * One queued move op, sent. Resolves with the row the server returned, when
 * there is one. Moves are never imported, so a 'bulk-add' can only be a
 * corrupt queue: it is refused, and the drain drops it.
 */
export async function sendMoveOp(op: MoveOp): Promise<BankrollMove | null> {
  if (op.kind === 'add') return addMove(op.input, op.id, insertStamp(op))
  if (op.kind === 'update') return updateMove(op.id, op.input, op.editedAt)
  if (op.kind === 'delete') {
    await deleteMove(op.id)
    return null
  }
  throw new Error('Deposits and withdrawals are never imported')
}

/** Fires `onChange` whenever this user's moves change on any device. Returns an unsubscribe function. */
export function subscribeToMoves(userId: string, onChange: () => void): () => void {
  const channel: RealtimeChannel = supabase
    .channel('moves-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLE, filter: `user_id=eq.${userId}` }, () => onChange())
    .subscribe()
  return () => {
    void supabase.removeChannel(channel)
  }
}
