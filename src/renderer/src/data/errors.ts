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
 * True when the backend refused a request because the database is behind the
 * app — a migration hasn't been run. That covers a column or table the app
 * knows about but the database doesn't have yet, and the one-bet-per-day
 * constraint that migration 001 removes. Callers use this to tell the user
 * exactly what to do instead of showing a raw PostgREST error.
 */
export function isMigrationNeededError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /column .*(stake|sport|book|bet_type|odds|status|closing_odds).* does not exist|could not find the .*(stake|sport|book|bet_type|odds|status|closing_odds).* column|relation .*user_settings.* does not exist|could not find the table .*user_settings|entries_user_id_date_key/i.test(
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
 *  - 'offline':  the server was unreachable. Keep it and retry later.
 *  - 'behind':   the database is missing a migration. Keep it too: it goes
 *                through once the migration runs, and dropping it would lose
 *                what the user typed.
 *  - 'rejected': the server refused it for good (validation, RLS, row gone).
 *                Drop it so it can't block the queue.
 */
export type SyncFailure = 'offline' | 'behind' | 'rejected'

export function classifySyncError(err: unknown): SyncFailure {
  if (isNetworkError(err)) return 'offline'
  if (err instanceof MigrationNeededError || isMigrationNeededError(err)) return 'behind'
  return 'rejected'
}
