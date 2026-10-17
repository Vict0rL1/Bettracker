import { describe, expect, it } from 'vitest'
import { classifySyncError, describeError, isAuthError, isMigrationNeededError, MIGRATION_HINT, MigrationNeededError, SignedOutError } from './errors'

describe('isMigrationNeededError', () => {
  it('recognises both wordings Postgres and PostgREST use for a missing column', () => {
    expect(isMigrationNeededError(new Error('column entries.status does not exist'))).toBe(true)
    expect(isMigrationNeededError(new Error("Could not find the 'stake' column of 'entries' in the schema cache"))).toBe(true)
    expect(isMigrationNeededError(new Error("Could not find the 'closing_odds' column of 'entries' in the schema cache"))).toBe(true)
  })

  it('recognises a missing settings table (004 not run)', () => {
    expect(isMigrationNeededError(new Error('relation "public.user_settings" does not exist'))).toBe(true)
    expect(isMigrationNeededError(new Error("Could not find the table 'public.user_settings' in the schema cache"))).toBe(true)
  })

  it('recognises a missing deposits and withdrawals table (005 not run)', () => {
    expect(isMigrationNeededError(new Error('relation "public.bankroll_moves" does not exist'))).toBe(true)
    expect(isMigrationNeededError(new Error("Could not find the table 'public.bankroll_moves' in the schema cache"))).toBe(true)
    expect(classifySyncError(describeError({ message: "Could not find the table 'public.bankroll_moves' in the schema cache" }))).toBe('behind')
  })

  it('recognises the one-bet-per-day constraint that 001 removes', () => {
    expect(isMigrationNeededError(new Error('duplicate key value violates unique constraint "entries_user_id_date_key"'))).toBe(true)
  })

  it('leaves other refusals alone', () => {
    expect(isMigrationNeededError(new Error('permission denied for table entries'))).toBe(false)
    expect(isMigrationNeededError(new Error('duplicate key value violates unique constraint "entries_pkey"'))).toBe(false)
    expect(isMigrationNeededError(new Error('new row for relation "entries" violates check constraint "entries_odds_gt_one"'))).toBe(false)
    // The table is there; the row is what was refused.
    expect(isMigrationNeededError(new Error('duplicate key value violates unique constraint "bankroll_moves_pkey"'))).toBe(false)
    expect(isMigrationNeededError(new Error('new row for relation "bankroll_moves" violates check constraint "bankroll_moves_amount_nonzero"'))).toBe(false)
    expect(isMigrationNeededError(new Error('permission denied for table bankroll_moves'))).toBe(false)
  })
})

describe('describeError', () => {
  it('turns a missing-migration error into the hint, as its own error type', () => {
    const err = describeError({ message: "Could not find the 'odds' column of 'entries' in the schema cache" })
    expect(err).toBeInstanceOf(MigrationNeededError)
    expect(err.message).toBe(MIGRATION_HINT)
  })

  it('passes anything else through with its message', () => {
    const err = describeError({ message: 'permission denied for table entries' })
    expect(err).not.toBeInstanceOf(MigrationNeededError)
    expect(err.message).toBe('permission denied for table entries')
  })
})

describe('classifySyncError — keep or drop a queued change', () => {
  it('keeps it when the server was unreachable', () => {
    expect(classifySyncError(new TypeError('Failed to fetch'))).toBe('offline')
    expect(classifySyncError(new Error('NetworkError when attempting to fetch resource.'))).toBe('offline')
  })

  it('keeps it when the database is missing a migration', () => {
    expect(classifySyncError(new MigrationNeededError())).toBe('behind')
    expect(classifySyncError(new Error("Could not find the table 'public.user_settings' in the schema cache"))).toBe('behind')
  })

  // These used to be dropped: a sign-out on another device, or a key the
  // project stops taking, would have emptied the queue.
  it('keeps it when Supabase refused who was asking rather than the change', () => {
    expect(classifySyncError(new SignedOutError())).toBe('offline')
    // The API gateway: a key from another project, the legacy keys switched off.
    expect(classifySyncError(new Error('Invalid API key'))).toBe('offline')
    expect(classifySyncError(new Error('Legacy API keys are disabled'))).toBe('offline')
    // PostgREST: a token that ran out or doesn't check out.
    expect(classifySyncError(describeError({ message: 'JWT expired' }))).toBe('offline')
    expect(classifySyncError(describeError({ message: 'JWT could not be decoded' }))).toBe('offline')
  })

  it('drops it when the server refused it for any other reason', () => {
    expect(classifySyncError(new Error('permission denied for table entries'))).toBe('rejected')
    expect(classifySyncError(new Error('new row violates row-level security policy for table "entries"'))).toBe('rejected')
    expect(classifySyncError('something odd')).toBe('rejected')
  })
})

describe('isAuthError', () => {
  it('is about who asked, not what was asked', () => {
    expect(isAuthError(new SignedOutError())).toBe(true)
    expect(isAuthError(new Error('Invalid API key'))).toBe(true)
    expect(isAuthError(new Error('value too long for type character varying(500)'))).toBe(false)
    expect(isAuthError(new Error('Failed to fetch'))).toBe(false)
  })
})
