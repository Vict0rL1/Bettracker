/**
 * How the data layer reads a failed request.
 *
 * Kept apart from the Supabase client so the outbox logic that depends on it
 * (data/drain.ts) can be tested without one.
 */

/**
 * A request Supabase answered with an error, as the data layer keeps it: its
 * words, plus the HTTP status and the error code when they came, which tell
 * a passing failure (a 503, a rate limit) from a refusal for good.
 */
export class SyncError extends Error {
  readonly status?: number
  readonly code?: string
  constructor(message: string, info: { status?: number; code?: string } = {}) {
    super(message)
    this.name = 'SyncError'
    this.status = info.status
    this.code = info.code
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** True when a request failed because the network/server was unreachable (retryable). */
export function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true
  // Status 0: no answer came. Any other status: the server answered, so its
  // words ("statement timeout") are not about the network.
  if (err instanceof SyncError && err.status !== undefined) return err.status === 0
  return /failed to fetch|networkerror|network request failed|load failed|fetch failed|err_internet|err_network|timeout/i.test(messageOf(err))
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
  if (err instanceof SyncError && err.status === 401) return true
  return /\bapi keys?\b|\bjwt\b/i.test(messageOf(err))
}

// Postgres and PostgREST codes for a failure that passes: no connection to
// the database (08…, PGRST000–003), a serialization failure or deadlock
// (40001, 40P01), the server out of resources (53…), shutting down or
// starting up (57P01–03), a statement timeout (57014).
const PASSING_CODE = /^(?:PGRST00[0-3]|08\d{3}|40001|40P01|53\d{3}|57P0[1-3]|57014)$/

/**
 * True when the server failed for now, not for good: a 5xx, a timeout, a rate
 * limit (429), or a database code that says the same. Retried with backoff.
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof SyncError) {
    const s = err.status
    if (s !== undefined && (s === 408 || s === 425 || s === 429 || (s >= 500 && s <= 599))) return true
    if (err.code !== undefined && PASSING_CODE.test(err.code)) return true
  }
  return /rate limit|too many requests|service unavailable|bad gateway|gateway time-?out|temporarily unavailable/i.test(messageOf(err))
}

/** A rate limit: the backoff starts longer. */
export const isRateLimit = (err: unknown): boolean =>
  (err instanceof SyncError && err.status === 429) || /rate limit|too many requests/i.test(messageOf(err))

/**
 * True when the backend refused a request because the database is behind the
 * app — a migration hasn't been run. That covers a column or table the app
 * knows about but the database doesn't have yet (the settings table of 004,
 * the deposits and withdrawals of 005), and the one-bet-per-day constraint
 * that migration 001 removes. Callers use this to tell the user exactly what
 * to do instead of showing a raw PostgREST error.
 */
export function isMigrationNeededError(err: unknown): boolean {
  return /column .*(stake|sport|book|bet_type|odds|status|closing_odds).* does not exist|could not find the .*(stake|sport|book|bet_type|odds|status|closing_odds).* column|relation .*(user_settings|bankroll_moves).* does not exist|could not find the table .*(user_settings|bankroll_moves)|entries_user_id_date_key/i.test(
    messageOf(err)
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

/**
 * The error a Supabase answer stands for, keeping its code and the response's
 * HTTP status (0 when the request never got an answer).
 */
export function describeError(error: { message: string; code?: string }, status?: number): Error {
  if (isMigrationNeededError(error.message)) return new MigrationNeededError()
  return new SyncError(error.message, { status, code: error.code || undefined })
}

/**
 * What to do with a queued change whose request failed:
 *  - 'offline':  the server was unreachable. Keep it; it goes when the
 *                connection is back.
 *  - 'paused':   Supabase refused who was asking (isAuthError). Keep it; it
 *                goes after the next sign-in, or with a copy of the app that
 *                has the right key.
 *  - 'retry':    the server failed for now (isTransientError). Keep it and
 *                try again after a growing wait.
 *  - 'behind':   the database is missing a migration. Keep it too: it goes
 *                through once the migration runs, and dropping it would lose
 *                what the user typed.
 *  - 'rejected': the server refused it for good (validation, RLS, row gone).
 *                It leaves the queue so it can't block it, and is kept apart
 *                where the user can send it again or let it go.
 */
export type SyncFailure = 'offline' | 'paused' | 'retry' | 'behind' | 'rejected'

export function classifySyncError(err: unknown): SyncFailure {
  if (isNetworkError(err)) return 'offline'
  if (isAuthError(err)) return 'paused'
  if (err instanceof MigrationNeededError || isMigrationNeededError(err)) return 'behind'
  if (isTransientError(err)) return 'retry'
  return 'rejected'
}

/**
 * How long to wait before attempt `n` (1, 2, …) after a passing failure:
 * doubling from a second (from five for a rate limit) up to two minutes,
 * spread by ±20 % so several windows don't retry in step.
 */
export function retryDelay(attempt: number, err?: unknown, random: () => number = Math.random): number {
  const base = isRateLimit(err) ? 5_000 : 1_000
  const delay = Math.min(base * 2 ** Math.max(0, attempt - 1), 120_000)
  return Math.round(delay * (0.8 + 0.4 * random()))
}
