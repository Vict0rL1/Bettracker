import type { RealtimeChannel } from '@supabase/supabase-js'
import { DEFAULT_SETTINGS, isOddsFormat, type Settings, type SettingsPatch } from '../../../shared/types'
import { supabase } from '../lib/supabase'
import { describeError } from './errors'
import { signedInUserId } from './session'

const TABLE = 'user_settings'

interface Row {
  user_id: string
  odds_format?: string | null
  unit_size?: number | string | null
  show_units?: boolean | null
  starting_bankroll?: number | string | null
  default_stake?: number | string | null
  loss_limit?: number | string | null
  updated_at: string
}

const num = (v: number | string | null | undefined): number | null =>
  v === null || v === undefined || v === '' ? null : Number(v)

function toSettings(row: Row): Settings {
  return {
    oddsFormat: isOddsFormat(row.odds_format) ? row.odds_format : DEFAULT_SETTINGS.oddsFormat,
    unitSize: num(row.unit_size),
    showUnits: row.show_units ?? DEFAULT_SETTINGS.showUnits,
    startingBankroll: num(row.starting_bankroll),
    defaultStake: num(row.default_stake),
    lossLimit: num(row.loss_limit),
    updatedAt: row.updated_at
  }
}

function toRowPatch(patch: SettingsPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (patch.oddsFormat !== undefined) out.odds_format = patch.oddsFormat
  if (patch.unitSize !== undefined) out.unit_size = patch.unitSize
  if (patch.showUnits !== undefined) out.show_units = patch.showUnits
  if (patch.startingBankroll !== undefined) out.starting_bankroll = patch.startingBankroll
  if (patch.defaultStake !== undefined) out.default_stake = patch.defaultStake
  if (patch.lossLimit !== undefined) out.loss_limit = patch.lossLimit
  return out
}

/** This user's row, or null when they have never changed a setting. */
export async function getSettings(): Promise<Settings | null> {
  // Without a session no row would come back, and the defaults would replace
  // this user's settings on the device.
  await signedInUserId()
  const { data, error, status } = await supabase.from(TABLE).select('*').maybeSingle()
  if (error) throw describeError(error, status)
  return data ? toSettings(data as Row) : null
}

/**
 * Apply a patch — same conflict rule as bets: the edit carries the moment it
 * was made, is written as `updated_at`, and only lands if the row is not
 * newer. A first-ever save inserts the row. Returns null when a newer edit
 * from another device already landed (the caller drops the patch and
 * refreshes).
 */
export async function saveSettings(patch: SettingsPatch, editedAt: string): Promise<Settings | null> {
  const user_id = await signedInUserId()
  const fields = { ...toRowPatch(patch), updated_at: editedAt }

  const updated = await supabase.from(TABLE).update(fields).eq('user_id', user_id).lte('updated_at', editedAt).select().maybeSingle()
  if (updated.error) throw describeError(updated.error, updated.status)
  if (updated.data) return toSettings(updated.data as Row)

  // No row matched: either there is none yet, or it is newer than this edit.
  const existing = await supabase.from(TABLE).select('updated_at').eq('user_id', user_id).maybeSingle()
  if (existing.error) throw describeError(existing.error, existing.status)
  if (existing.data) return null

  const inserted = await supabase.from(TABLE).insert({ user_id, ...fields }).select().single()
  if (inserted.error) {
    // Lost a race with another device's first save; treat as a conflict.
    if (inserted.error.code === '23505') return null
    throw describeError(inserted.error, inserted.status)
  }
  return toSettings(inserted.data as Row)
}

export function subscribeToSettings(userId: string, onChange: () => void): () => void {
  const channel: RealtimeChannel = supabase
    .channel('settings-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLE, filter: `user_id=eq.${userId}` }, () => onChange())
    .subscribe()
  return () => {
    void supabase.removeChannel(channel)
  }
}

