/**
 * How the data layer reads a failed request.
 *
 * Kept apart from the Supabase client so the outbox logic that depends on it
 * (data/drain.ts) can be tested without one.
 */

/** True when a request failed because the network/server was unreachable (retryable). */
export function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true
  const msg = err instanceof Error ? err.message : String(err)
  return /failed to fetch|networkerror|network request failed|load failed|fetch failed|err_internet|err_network|timeout/i.test(
    msg
  )
}

/**
 * A request with no session behind it: the session ran out and could not be
 * renewed (signing out on another device ends it on every device, for one).
 * Sent anyway, supabase-js would go as nobody, and row-level security would
 * hide every row: a read would come back empty and wipe this device's copy,
 * an edit would find nothing to change, an add would be refused. So the data
 * layer asks first (data/session.ts) and stops with this.
 */
export class SignedOutError extends Error {
  constructor() {
    super('You are signed out — sign in to sync')
    this.name = 'SignedOutError'
  }
}

/**
 * True when Supabase refused who was asking, not what was asked: no session,
 * an expired or bad token, or an API key it doesn't take (another project's,
 * or the legacy keys once they are switched off). Nothing is wrong with the
 * change itself.
 */
export function isAuthError(err: unknown): boolean {
  if (err instanceof SignedOutError) return true
  const msg = err instanceof Error ? err.message : String(err)
  return /\bapi keys?\b|\bjwt\b/i.test(msg)
}

/**
 * True when the backend refused a request because the database is behind the
 * app — a migration hasn't been run. That covers a column or table the app
 * knows about but the database doesn't have yet (the settings table of 004,
 * the deposits and withdrawals of 005), and the one-bet-per-day constraint
 * that migration 001 removes. Callers use this to tell the user exactly what
 * to do instead of showing a raw PostgREST error.
 */
export function isMigrationNeededError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /column .*(stake|sport|book|bet_type|odds|status|closing_odds).* does not exist|could not find the .*(stake|sport|book|bet_type|odds|status|closing_odds).* column|relation .*(user_settings|bankroll_moves).* does not exist|could not find the table .*(user_settings|bankroll_moves)|entries_user_id_date_key/i.test(
    msg
  )
}

export const MIGRATION_HINT =
  'Your database is behind the app. Run the files in supabase/migrations/ that you have not run yet, in order, in your Supabase SQL editor. Until then your changes are kept on this device.'

/** A request the database refused because it is missing a migration; its message is the hint. */
export class MigrationNeededError extends Error {
  constructor() {
    super(MIGRATION_HINT)
    this.name = 'MigrationNeededError'
  }
}

export function describeError(error: { message: string }): Error {
  const err = new Error(error.message)
  return isMigrationNeededError(err) ? new MigrationNeededError() : err
}

/**
 * What to do with a queued change whose request failed:
 *  - 'offline':  the server was unreachable, or refused who was asking
 *                (isAuthError). Keep it and retry later: after the next
 *                sign-in, or with a copy of the app that has the right key.
 *  - 'behind':   the database is missing a migration. Keep it too: it goes
 *                through once the migration runs, and dropping it would lose
 *                what the user typed.
 *  - 'rejected': the server refused it for good (validation, RLS, row gone).
 *                Drop it so it can't block the queue.
 */
export type SyncFailure = 'offline' | 'behind' | 'rejected'

export function classifySyncError(err: unknown): SyncFailure {
  if (isNetworkError(err) || isAuthError(err)) return 'offline'
  if (err instanceof MigrationNeededError || isMigrationNeededError(err)) return 'behind'
  return 'rejected'
}
