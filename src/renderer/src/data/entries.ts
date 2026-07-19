import type { RealtimeChannel } from '@supabase/supabase-js'
import type { BetEntry, EntryInput } from '../../../shared/types'
import { supabase } from '../lib/supabase'
import { normalizeInput } from '../lib/validate'

interface Row {
  id: string
  date: string
  amount: number | string
  note: string | null
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
    note: row.note ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
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
  if (error) throw new Error(error.message)
  return (data as Row[]).map(toEntry)
}

/**
 * Add one session. `id` is a client-generated UUID so an offline retry of the
 * same insert is recognized as a duplicate instead of creating a second row.
 */
export async function addEntry(input: EntryInput, id?: string): Promise<BetEntry> {
  const clean = normalizeInput(input)
  const user_id = await currentUserId()
  const payload = { user_id, date: clean.date, amount: clean.amount, note: clean.note, ...(id ? { id } : {}) }
  const { data, error } = await supabase.from(TABLE).insert(payload).select().single()
  if (error) {
    if (error.code === '23505' && id) {
      // Already inserted by an earlier attempt whose response we never saw.
      const { data: existing } = await supabase.from(TABLE).select('*').eq('id', id).single()
      if (existing) return toEntry(existing as Row)
    }
    throw new Error(error.message)
  }
  return toEntry(data as Row)
}

/** Edit one existing session by id. */
export async function updateEntry(id: string, input: EntryInput): Promise<BetEntry> {
  const clean = normalizeInput(input)
  const { data, error } = await supabase
    .from(TABLE)
    .update({ date: clean.date, amount: clean.amount, note: clean.note, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return toEntry(data as Row)
}

/** Delete one session by id. */
export async function deleteEntry(id: string): Promise<boolean> {
  const { error, count } = await supabase.from(TABLE).delete({ count: 'exact' }).eq('id', id)
  if (error) throw new Error(error.message)
  return (count ?? 0) > 0
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
