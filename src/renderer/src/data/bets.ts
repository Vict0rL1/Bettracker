import type { RealtimeChannel } from '@supabase/supabase-js'
import { statusForAmount, isBetStatus, type Bet, type BetInput } from '../../../shared/types'
import { supabase } from '../lib/supabase'
import { normalizeInput, type CleanBet } from '../lib/validate'

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

/** True when a request failed because the network/server was unreachable (retryable). */
export function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true
  const msg = err instanceof Error ? err.message : String(err)
  return /failed to fetch|networkerror|network request failed|load failed|fetch failed|err_internet|err_network|timeout/i.test(
    msg
  )
}

/**
 * True when the backend rejected a column the app knows about but the database
 * doesn't have yet — i.e. a migration hasn't been run. Callers use this to tell
 * the user exactly what to do instead of showing a raw PostgREST error.
 */
export function isMissingColumnError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /column .*(stake|sport|book|bet_type|odds|status|closing_odds).* does not exist|could not find the .*(stake|sport|book|bet_type|odds|status|closing_odds).* column|relation .*user_settings.* does not exist|could not find the table .*user_settings/i.test(
    msg
  )
}

export const MIGRATION_HINT =
  'Your database is behind the app. Run the files in supabase/migrations/ (002, 003, then 004) in your Supabase SQL editor.'

export function describeError(error: { message: string }): Error {
  const err = new Error(error.message)
  return isMissingColumnError(err) ? new Error(MIGRATION_HINT) : err
}

async function currentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  const id = data.session?.user?.id
  if (!id) throw new Error('You are signed out — sign in to sync your bets')
  return id
}

export async function getBets(): Promise<Bet[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .order('date', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw describeError(error)
  return (data as Row[]).map(toBet)
}

/**
 * Add one bet. `id` is a client-generated UUID so an offline retry of the same
 * insert is recognized as a duplicate instead of creating a second row.
 */
export async function addBet(input: BetInput, id?: string): Promise<Bet> {
  const clean = normalizeInput(input)
  const user_id = await currentUserId()
  const payload = { user_id, ...toRowPayload(clean), ...(id ? { id } : {}) }
  const { data, error } = await supabase.from(TABLE).insert(payload).select().single()
  if (error) {
    if (error.code === '23505' && id) {
      // Already inserted by an earlier attempt whose response we never saw.
      const { data: existing } = await supabase.from(TABLE).select('*').eq('id', id).single()
      if (existing) return toBet(existing as Row)
    }
    throw describeError(error)
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
  const { data, error } = await supabase
    .from(TABLE)
    .update({ ...toRowPayload(clean), updated_at: editedAt })
    .eq('id', id)
    .lte('updated_at', editedAt)
    .select()
    .maybeSingle()
  if (error) throw describeError(error)
  return data ? toBet(data as Row) : null
}

/** Delete one bet by id. */
export async function deleteBet(id: string): Promise<boolean> {
  const { error, count } = await supabase.from(TABLE).delete({ count: 'exact' }).eq('id', id)
  if (error) throw describeError(error)
  return (count ?? 0) > 0
}

/**
 * Insert many bets at once (CSV import). Rows are sent in chunks so a large
 * file doesn't hit request-size limits, and ids are client-generated so a
 * partially-applied import can be re-run without duplicating rows.
 */
export async function addBets(inputs: readonly { id: string; input: BetInput }[]): Promise<number> {
  if (inputs.length === 0) return 0
  const user_id = await currentUserId()
  const rows = inputs.map(({ id, input }) => ({ id, user_id, ...toRowPayload(normalizeInput(input)) }))

  const CHUNK = 250
  let written = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    // upsert (not insert) so re-running an interrupted import is idempotent.
    const { error, count } = await supabase.from(TABLE).upsert(chunk, { count: 'exact', onConflict: 'id' })
    if (error) throw describeError(error)
    written += count ?? chunk.length
  }
  return written
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
