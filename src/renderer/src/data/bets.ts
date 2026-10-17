import type { RealtimeChannel } from '@supabase/supabase-js'
import { statusForAmount, isBetStatus, type Bet, type BetInput } from '../../../shared/types'
import { supabase } from '../lib/supabase'
import { isValidDate, MAX_AMOUNT, normalizeInput, round2, type CleanBet } from '../lib/validate'
import { describeError } from './errors'
import { signedInUserId } from './session'
import { readAll } from './readAll'
import { insertStamp, type PendingOp } from './offline'

// The table keeps its original name: renaming it is not an additive migration
// and every policy and index refers to it. Everywhere else these are bets.
const TABLE = 'entries'

interface Row {
  id: string
  date: string
  amount: number | string | null
  stake?: number | string | null
  odds?: number | string | null
  closing_odds?: number | string | null
  status?: string | null
  note: string | null
  sport?: string | null
  book?: string | null
  bet_type?: string | null
  created_at: string
  updated_at: string
}

const num = (v: number | string | null | undefined): number | null =>
  v === null || v === undefined || v === '' ? null : Number(v)

// PostgREST returns numeric columns as strings to preserve precision — coerce.
// A row from a database that hasn't had migration 003 has no status column:
// it gets the status its amount implies, exactly as the migration will.
function toBet(row: Row): Bet {
  const amount = num(row.amount)
  const status = isBetStatus(row.status) ? row.status : amount === null ? 'pending' : statusForAmount(amount)
  return {
    id: row.id,
    date: row.date,
    amount: status === 'pending' ? null : (amount ?? 0),
    stake: num(row.stake),
    odds: num(row.odds),
    closingOdds: num(row.closing_odds),
    status,
    note: row.note ?? '',
    sport: row.sport ?? '',
    book: row.book ?? '',
    betType: row.bet_type ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** The column shape a clean bet writes to. */
function toRowPayload(clean: CleanBet): Record<string, unknown> {
  return {
    date: clean.date,
    amount: clean.amount,
    stake: clean.stake,
    odds: clean.odds,
    closing_odds: clean.closingOdds,
    status: clean.status,
    note: clean.note,
    sport: clean.sport,
    book: clean.book,
    bet_type: clean.betType
  }
}

export async function getBets(): Promise<Bet[]> {
  // Without a session the answer would be no rows, not this user's rows.
  await signedInUserId()
  const rows = await readAll<Row>((from, to) =>
    supabase
      .from(TABLE)
      .select('*', { count: 'exact' })
      .order('date', { ascending: true })
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
  )
  return rows.map(toBet)
}

/**
 * Add one bet. `id` is a client-generated UUID so an offline retry of the same
 * insert is recognized as a duplicate instead of creating a second row.
 *
 * `queuedAt` is the device time of its content (see insertStamp: when it was
 * logged, or last edited before it was sent), written as `updated_at` so the
 * conflict check below compares device times only. Left to the server's
 * clock, the row could look newer than an edit the user made while the
 * insert was still on its way, and that edit would be refused.
 */
export async function addBet(input: BetInput, id?: string, queuedAt?: string): Promise<Bet> {
  const clean = normalizeInput(input)
  const user_id = await signedInUserId()
  const payload = { user_id, ...toRowPayload(clean), ...(id ? { id } : {}), ...(queuedAt ? { updated_at: queuedAt } : {}) }
  const { data, error, status } = await supabase.from(TABLE).insert(payload).select().single()
  if (error) {
    if (error.code === '23505' && id) {
      // Already inserted by an earlier attempt whose response we never saw.
      const back = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle()
      // Couldn't tell: the same failure, tried again later.
      if (back.error) throw describeError(back.error, back.status)
      if (back.data) return toBet(back.data as Row)
    }
    throw describeError(error, status)
  }
  return toBet(data as Row)
}

/**
 * Edit one bet — last write wins, by when the edit was made.
 *
 * Two devices can edit the same bet offline. Each edit carries `editedAt`, the
 * moment the user made it, and it is written as the row's `updated_at`. The
 * update only applies if the row's `updated_at` is not newer: if another
 * device's later edit already landed, this one is refused (no row comes back),
 * the caller drops it, and the refresh that follows shows the winning version.
 * A retry of the same edit after a lost response still applies, because its
 * own timestamp satisfies the check. Device clocks are trusted; a device with
 * a clock far in the future would win every conflict, which is the accepted
 * cost of needing no server-side logic.
 *
 * Returns null when the edit was refused or the row no longer exists.
 */
export async function updateBet(id: string, input: BetInput, editedAt: string): Promise<Bet | null> {
  const clean = normalizeInput(input)
  const { data, error, status } = await supabase
    .from(TABLE)
    .update({ ...toRowPayload(clean), updated_at: editedAt })
    .eq('id', id)
    .lte('updated_at', editedAt)
    .select()
    .maybeSingle()
  if (error) throw describeError(error, status)
  return data ? toBet(data as Row) : null
}

/**
 * Send an edit queued by a version from before migration 003 the way that
 * version sent it (see loadOutbox): only the fields it knew and its input
 * carries, never status, odds or closing odds, so nothing it did not know
 * about is blanked and the 003 trigger works the status out exactly as for
 * a write from that version. Same conflict rule as updateBet.
 */
export async function updateBetLegacy(id: string, input: BetInput, editedAt: string): Promise<Bet | null> {
  if (!isValidDate(input.date)) throw new Error(`"${input.date}" is not a valid calendar date`)
  const amount = input.amount
  if (typeof amount !== 'number' || !Number.isFinite(amount) || Math.abs(amount) > MAX_AMOUNT) throw new Error('Amount must be a finite number')
  const payload: Record<string, unknown> = { date: input.date, amount: round2(amount), updated_at: editedAt }
  if ('note' in input) payload.note = input.note ?? ''
  if ('stake' in input) {
    const stake = input.stake
    if (stake !== null && stake !== undefined && (!Number.isFinite(stake) || stake < 0 || stake > MAX_AMOUNT)) throw new Error('Stake is out of range')
    payload.stake = stake === null || stake === undefined ? null : round2(stake)
  }
  if ('sport' in input) payload.sport = input.sport ?? ''
  if ('book' in input) payload.book = input.book ?? ''
  if ('betType' in input) payload.bet_type = input.betType ?? ''
  const { data, error, status } = await supabase.from(TABLE).update(payload).eq('id', id).lte('updated_at', editedAt).select().maybeSingle()
  if (error) throw describeError(error, status)
  return data ? toBet(data as Row) : null
}

/** Delete one bet by id. */
export async function deleteBet(id: string): Promise<boolean> {
  const { error, count, status } = await supabase.from(TABLE).delete({ count: 'exact' }).eq('id', id)
  if (error) throw describeError(error, status)
  return (count ?? 0) > 0
}

/** Rows per request of an import. */
export const IMPORT_CHUNK = 250

/**
 * Insert many bets at once (CSV import). Rows are sent in chunks so a large
 * file doesn't hit request-size limits. `queuedAt` is written as each row's
 * `updated_at`, as in addBet.
 *
 * An interrupted import is sent again, and must not undo what happened to
 * the rows that did land: another device may have edited one since (a newer
 * `updated_at`) or deleted it. So the chunks the server confirmed are
 * skipped (`done`, kept up to date through `progress`), and a row that is
 * already there is left as the server has it (ON CONFLICT DO NOTHING) — the
 * chunk whose answer was lost may have landed. Ids are client-generated, so
 * a row of this import can only collide with itself. Resolves with how many
 * rows this call inserted.
 */
export async function addBets(
  inputs: readonly { id: string; input: BetInput }[],
  queuedAt?: string,
  done = 0,
  progress?: (done: number) => Promise<void>
): Promise<number> {
  if (inputs.length <= done) return 0
  const user_id = await signedInUserId()
  const stamp = queuedAt ? { updated_at: queuedAt } : {}
  const rows = inputs.map(({ id, input }) => ({ id, user_id, ...toRowPayload(normalizeInput(input)), ...stamp }))

  let written = 0
  for (let i = done; i < rows.length; i += IMPORT_CHUNK) {
    const chunk = rows.slice(i, i + IMPORT_CHUNK)
    const { error, count, status } = await supabase.from(TABLE).upsert(chunk, { count: 'exact', onConflict: 'id', ignoreDuplicates: true })
    if (error) throw describeError(error, status)
    written += count ?? chunk.length
    await progress?.(i + chunk.length)
  }
  return written
}

/**
 * One queued op, sent. An insert is stamped with insertStamp (the device time
 * of its content); an edit queued by a version from before 003 goes out the
 * way that version sent it. Resolves with the row the server returned, when
 * there is one.
 */
export async function sendOp(op: PendingOp, progress?: (done: number) => Promise<void>): Promise<Bet | null> {
  // An edit or a delete sent without a session would find no row and leave
  // the queue as if refused: it waits for the next sign-in instead.
  await signedInUserId()
  if (op.kind === 'add') return addBet(op.input, op.id, insertStamp(op))
  if (op.kind === 'update') return op.legacy ? updateBetLegacy(op.id, op.input, op.editedAt) : updateBet(op.id, op.input, op.editedAt)
  if (op.kind === 'bulk-add') await addBets(op.entries, insertStamp(op), op.done ?? 0, progress)
  else await deleteBet(op.id)
  return null
}

/**
 * Live-update hook: fires `onChange` whenever this user's rows change on any
 * device. Returns an unsubscribe function.
 */
export function subscribeToBets(userId: string, onChange: () => void): () => void {
  const channel: RealtimeChannel = supabase
    .channel('entries-sync')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: TABLE, filter: `user_id=eq.${userId}` },
      () => onChange()
    )
    .subscribe()

  return () => {
    void supabase.removeChannel(channel)
  }
}
