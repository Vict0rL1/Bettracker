import { describe, expect, it } from 'vitest'
import { classifySyncError, describeError, isMigrationNeededError, MIGRATION_HINT, MigrationNeededError } from './errors'

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

  it('recognises the one-bet-per-day constraint that 001 removes', () => {
    expect(isMigrationNeededError(new Error('duplicate key value violates unique constraint "entries_user_id_date_key"'))).toBe(true)
  })

  it('leaves other refusals alone', () => {
    expect(isMigrationNeededError(new Error('permission denied for table entries'))).toBe(false)
    expect(isMigrationNeededError(new Error('duplicate key value violates unique constraint "entries_pkey"'))).toBe(false)
    expect(isMigrationNeededError(new Error('new row for relation "entries" violates check constraint "entries_odds_gt_one"'))).toBe(false)
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

  it('drops it when the server refused it for any other reason', () => {
    expect(classifySyncError(new Error('permission denied for table entries'))).toBe('rejected')
    expect(classifySyncError('something odd')).toBe('rejected')
  })
})
