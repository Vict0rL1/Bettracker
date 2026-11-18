import type { RealtimeChannel } from '@supabase/supabase-js'
import { DEFAULT_SETTINGS, isCurrencyCode, isOddsFormat, type Settings, type SettingsPatch } from '../../../shared/types'
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
  /** Migration 008; missing from a database without it. */
  expense_currency?: string | null
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
    expenseCurrency: isCurrencyCode(row.expense_currency) ? row.expense_currency : DEFAULT_SETTINGS.expenseCurrency,
    updatedAt: row.updated_at
  }
}

const COLUMNS: Record<keyof SettingsPatch, string> = {
  oddsFormat: 'odds_format',
  unitSize: 'unit_size',
  showUnits: 'show_units',
  startingBankroll: 'starting_bankroll',
  defaultStake: 'default_stake',
  lossLimit: 'loss_limit',
  expenseCurrency: 'expense_currency'
}

/** The columns a patch writes: every field it sets, by COLUMNS, so a new field can never be forgotten here. */
function toRowPatch(patch: SettingsPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, column] of Object.entries(COLUMNS) as [keyof SettingsPatch, string][]) if (patch[key] !== undefined) out[column] = patch[key]
  return out
}

/**
 * This user's row (null when they have never changed a setting), and whether
 * the table has the currency column of migration 008: a row with the key
 * says it has (true), one without it says it hasn't (false), and no row says
 * nothing either way (null; see settingsReadClears in drain.ts).
 */
export async function getSettingsRead(asUser?: string): Promise<{ settings: Settings | null; hasCurrencyColumn: boolean | null }> {
  // Without a session no row would come back, and the defaults would replace
  // this user's settings on the device.
  await signedInUserId(asUser)
  const { data, error, status } = await supabase.from(TABLE).select('*').maybeSingle()
  if (error) throw describeError(error, status)
  if (!data) return { settings: null, hasCurrencyColumn: null }
  return { settings: toSettings(data as Row), hasCurrencyColumn: 'expense_currency' in (data as object) }
}

/** This user's row, or null when they have never changed a setting. */
export async function getSettings(asUser?: string): Promise<Settings | null> {
  return (await getSettingsRead(asUser)).settings
}

/**
 * Apply a patch — same conflict rule as bets: the edit carries the moment it
 * was made, is written as `updated_at`, and only lands if the row is not
 * newer. A first-ever save inserts the row. Returns null when a newer edit
 * from another device already landed (the caller drops the patch and
 * refreshes).
 */
export async function saveSettings(patch: SettingsPatch, editedAt: string, asUser?: string, guard?: SettingsPatch): Promise<Settings | null> {
  const user_id = await signedInUserId(asUser)
  const guarded = Object.keys(guard ?? {}).filter((k) => k in patch) as (keyof SettingsPatch)[]
  if (guarded.length > 0) return saveGuarded(user_id, patch, editedAt, guard ?? {}, guarded, asUser)
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

/**
 * A patch with guarded fields (see PendingSettings.guard): the plain fields
 * are saved as by saveSettings, then each guarded field in a statement of its
 * own that applies only where the row still holds the guard's value (and is
 * not newer than this edit). A guarded field that no longer holds it is left
 * as it is: someone changed it since. Resolves with the row as it is then
 * (null only when the plain fields lost to a newer edit and no row is left
 * to show).
 */
async function saveGuarded(
  user_id: string,
  patch: SettingsPatch,
  editedAt: string,
  guard: SettingsPatch,
  guarded: (keyof SettingsPatch)[],
  asUser?: string
): Promise<Settings | null> {
  const plain = Object.fromEntries(Object.entries(patch).filter(([k]) => !guarded.includes(k as keyof SettingsPatch))) as SettingsPatch
  let row: Settings | null = null
  if (Object.keys(plain).length > 0) row = await saveSettings(plain, editedAt, asUser)
  for (const key of guarded) {
    const column = COLUMNS[key]
    const was = guard[key] ?? null
    const base = supabase
      .from(TABLE)
      .update({ ...toRowPatch({ [key]: patch[key] } as SettingsPatch), updated_at: editedAt })
      .eq('user_id', user_id)
      .lte('updated_at', editedAt)
    const { data, error, status } = await (was === null ? base.is(column, null) : base.eq(column, was)).select().maybeSingle()
    if (error) throw describeError(error, status)
    if (data) row = toSettings(data as Row)
  }
  if (row) return row
  const back = await supabase.from(TABLE).select('*').eq('user_id', user_id).maybeSingle()
  if (back.error) throw describeError(back.error, back.status)
  if (back.data) return toSettings(back.data as Row)
  // No row yet: the server holds the defaults. A guarded field whose guard is
  // the default applies (a first save); one whose guard is not, finds the
  // value it was guarded against gone, and is left as the defaults have it.
  const fits = guarded.filter((k) => sameSetting(guard[k] ?? null, (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[k] ?? null))
  if (fits.length === 0) return { ...DEFAULT_SETTINGS }
  const first = Object.fromEntries(fits.map((k) => [k, patch[k]])) as SettingsPatch
  const inserted = await supabase
    .from(TABLE)
    .insert({ user_id, ...toRowPatch(first), updated_at: editedAt })
    .select()
    .single()
  if (inserted.error) {
    // Another device's first save got there first: treat as a conflict.
    if (inserted.error.code === '23505') return null
    throw describeError(inserted.error, inserted.status)
  }
  return toSettings(inserted.data as Row)
}

/** Equal as settings: numbers within a cent (the server rounds), anything else exactly. */
const sameSetting = (a: unknown, b: unknown): boolean =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 0.005 : Object.is(a ?? null, b ?? null)

export function subscribeToSettings(userId: string, onChange: () => void): () => void {
  const channel: RealtimeChannel = supabase
    .channel('settings-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLE, filter: `user_id=eq.${userId}` }, () => onChange())
    .subscribe()
  return () => {
    void supabase.removeChannel(channel)
  }
}

