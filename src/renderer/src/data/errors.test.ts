import { describe, expect, it } from 'vitest'
import { classifySyncError, describeError, isAuthError, isMigrationNeededError, MIGRATION_HINT, MigrationNeededError, retryDelay, SignedOutError, SyncError } from './errors'

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
  it('keeps it, paused, when Supabase refused who was asking rather than the change', () => {
    expect(classifySyncError(new SignedOutError())).toBe('paused')
    // The API gateway: a key from another project, the legacy keys switched off.
    expect(classifySyncError(new Error('Invalid API key'))).toBe('paused')
    expect(classifySyncError(new Error('Legacy API keys are disabled'))).toBe('paused')
    // PostgREST: a token that ran out or doesn't check out.
    expect(classifySyncError(describeError({ message: 'JWT expired', code: 'PGRST303' }, 401))).toBe('paused')
    expect(classifySyncError(describeError({ message: 'JWT could not be decoded' }))).toBe('paused')
  })

  // These used to be dropped as refusals.
  it('keeps it, to try again, when the server failed for now', () => {
    for (const status of [408, 429, 500, 502, 503, 504, 520, 530]) {
      expect(classifySyncError(describeError({ message: 'whatever it says' }, status)), String(status)).toBe('retry')
    }
    // No status, but a code or words that say the same.
    expect(classifySyncError(describeError({ message: 'Could not connect to the database', code: 'PGRST000' }))).toBe('retry')
    expect(classifySyncError(describeError({ message: 'deadlock detected', code: '40P01' }))).toBe('retry')
    expect(classifySyncError(describeError({ message: 'sorry, too many clients already', code: '53300' }))).toBe('retry')
    expect(classifySyncError(new Error('Too Many Requests'))).toBe('retry')
  })

  it('reads an answer the server gave as an answer, not as a lost connection', () => {
    // "statement timeout" is the database's words, with a 500: a passing failure.
    expect(classifySyncError(describeError({ message: 'canceling statement due to statement timeout', code: '57014' }, 500))).toBe('retry')
    // Status 0: no answer came.
    expect(classifySyncError(describeError({ message: 'TypeError: Failed to fetch' }, 0))).toBe('offline')
  })

  it('drops it when the server refused it for any other reason', () => {
    expect(classifySyncError(new Error('permission denied for table entries'))).toBe('rejected')
    expect(classifySyncError(new Error('new row violates row-level security policy for table "entries"'))).toBe('rejected')
    expect(classifySyncError('something odd')).toBe('rejected')
  })
})

describe('describeError', () => {
  it('keeps the status and the code with the words', () => {
    const err = describeError({ message: 'new row violates check constraint', code: '23514' }, 400)
    expect(err).toBeInstanceOf(SyncError)
    expect(err).toMatchObject({ message: 'new row violates check constraint', status: 400, code: '23514' })
    expect(classifySyncError(err)).toBe('rejected')
  })
})

describe('retryDelay', () => {
  it('doubles from a second up to two minutes, and from five seconds for a rate limit', () => {
    const mid = () => 0.5
    expect([1, 2, 3, 4].map((n) => retryDelay(n, undefined, mid))).toEqual([1000, 2000, 4000, 8000])
    expect(retryDelay(20, undefined, mid)).toBe(120_000)
    expect(retryDelay(1, describeError({ message: 'slow down' }, 429), mid)).toBe(5000)
  })

  it('spreads each wait by ±20 %, so windows don’t retry in step', () => {
    expect(retryDelay(1, undefined, () => 0)).toBe(800)
    expect(retryDelay(1, undefined, () => 1)).toBe(1200)
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
