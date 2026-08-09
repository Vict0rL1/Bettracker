import type { RealtimeChannel } from '@supabase/supabase-js'
import type { BetEntry, EntryInput } from '../../../shared/types'
import { supabase } from '../lib/supabase'
import { normalizeInput, type CleanEntry } from '../lib/validate'

interface Row {
  id: string
  date: string
  amount: number | string
  stake?: number | string | null
  note: string | null
  sport?: string | null
  book?: string | null
  bet_type?: string | null
  created_at: string
  updated_at: string
}

const TABLE = 'entries'

// PostgREST returns numeric columns as strings to preserve precision — coerce.
function toEntry(row: Row): BetEntry {
  return {
    id: row.id,
    date: row.date,
    amount: Number(row.amount),
    stake: row.stake === null || row.stake === undefined ? null : Number(row.stake),
    note: row.note ?? '',
    sport: row.sport ?? '',
    book: row.book ?? '',
    betType: row.bet_type ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** The column shape a clean entry writes to. */
function toRowPayload(clean: CleanEntry): Record<string, unknown> {
  return {
    date: clean.date,
    amount: clean.amount,
    stake: clean.stake,
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
 * doesn't have yet — i.e. the stake/tags migration hasn't been run. Callers use
 * this to tell the user exactly what to do instead of showing a raw PostgREST
 * error.
 */
export function isMissingColumnError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /column .*(stake|sport|book|bet_type).* does not exist|could not find the .*(stake|sport|book|bet_type).* column/i.test(
    msg
  )
}

export const MIGRATION_HINT =
  'Your database is missing the stake/tags columns. Run supabase/migrations/002_stake_and_tags.sql in your Supabase SQL editor.'

function describe(error: { message: string }): Error {
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

export async function getEntries(): Promise<BetEntry[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .order('date', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw describe(error)
  return (data as Row[]).map(toEntry)
}

/**
 * Add one session. `id` is a client-generated UUID so an offline retry of the
 * same insert is recognized as a duplicate instead of creating a second row.
 */
export async function addEntry(input: EntryInput, id?: string): Promise<BetEntry> {
  const clean = normalizeInput(input)
  const user_id = await currentUserId()
  const payload = { user_id, ...toRowPayload(clean), ...(id ? { id } : {}) }
  const { data, error } = await supabase.from(TABLE).insert(payload).select().single()
  if (error) {
    if (error.code === '23505' && id) {
      // Already inserted by an earlier attempt whose response we never saw.
      const { data: existing } = await supabase.from(TABLE).select('*').eq('id', id).single()
      if (existing) return toEntry(existing as Row)
    }
    throw describe(error)
  }
  return toEntry(data as Row)
}

/** Edit one existing session by id. */
export async function updateEntry(id: string, input: EntryInput): Promise<BetEntry> {
  const clean = normalizeInput(input)
  const { data, error } = await supabase
    .from(TABLE)
    .update({ ...toRowPayload(clean), updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
  if (error) throw describe(error)
  return toEntry(data as Row)
}

/** Delete one session by id. */
export async function deleteEntry(id: string): Promise<boolean> {
  const { error, count } = await supabase.from(TABLE).delete({ count: 'exact' }).eq('id', id)
  if (error) throw describe(error)
  return (count ?? 0) > 0
}

/**
 * Insert many entries at once (CSV import). Rows are sent in chunks so a large
 * file doesn't hit request-size limits, and ids are client-generated so a
 * partially-applied import can be re-run without duplicating rows.
 */
export async function addEntries(inputs: readonly { id: string; input: EntryInput }[]): Promise<number> {
  if (inputs.length === 0) return 0
  const user_id = await currentUserId()
  const rows = inputs.map(({ id, input }) => ({ id, user_id, ...toRowPayload(normalizeInput(input)) }))

  const CHUNK = 250
  let written = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    // upsert (not insert) so re-running an interrupted import is idempotent.
    const { error, count } = await supabase.from(TABLE).upsert(chunk, { count: 'exact', onConflict: 'id' })
    if (error) throw describe(error)
    written += count ?? chunk.length
  }
  return written
}

/**
 * Live-update hook: fires `onChange` whenever this user's rows change on any
 * device. Returns an unsubscribe function.
 */
export function subscribeToEntries(userId: string, onChange: () => void): () => void {
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
