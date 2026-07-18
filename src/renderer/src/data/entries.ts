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

async function currentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  const id = data.session?.user?.id
  if (!id) throw new Error('You are signed out — sign in to sync your bets')
  return id
}

export async function getEntries(): Promise<BetEntry[]> {
  const { data, error } = await supabase.from(TABLE).select('*').order('date', { ascending: true })
  if (error) throw new Error(error.message)
  return (data as Row[]).map(toEntry)
}

export async function upsertEntry(input: EntryInput): Promise<BetEntry> {
  const clean = normalizeInput(input)
  const user_id = await currentUserId()
  const { data, error } = await supabase
    .from(TABLE)
    .upsert(
      { user_id, date: clean.date, amount: clean.amount, note: clean.note, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,date' }
    )
    .select()
    .single()
  if (error) throw new Error(error.message)
  return toEntry(data as Row)
}

export async function deleteEntry(date: string): Promise<boolean> {
  const { error, count } = await supabase
    .from(TABLE)
    .delete({ count: 'exact' })
    .eq('date', date)
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
