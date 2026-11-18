import {
  EXTRACT_ERROR_CODES,
  EXTRACT_FUNCTION,
  normalizeExtraction,
  type ExtractErrorCode,
  type ExtractRequest,
  type ExtractResult
} from '../../../shared/expenseExtraction'
import { isFakeBackend, supabase } from '../lib/supabase'
import { isNetworkError, SignedOutError } from './errors'
import { signedInUserId } from './session'

/**
 * The AI reading of a receipt, from the app's side: one call to the
 * `extract-expenses` Edge Function, and every way it can fail as a code the
 * sheet puts in words (scan.err.<code>). It holds no queue lock and writes
 * nothing: what comes back is only shown for review, and the reviewed rows go
 * through the expenses' normal queue. The answer is checked again here
 * (normalizeExtraction): nothing the function or the model sends is trusted.
 */

/** Why a reading didn't happen. The function's own codes, and the ones only the app can tell. */
export type ScanErrorCode = ExtractErrorCode | 'offline' | 'signed_out' | 'not_deployed' | 'network' | 'cancelled' | 'heic' | 'unreadable'

export const SCAN_ERROR_CODES: readonly ScanErrorCode[] = [...EXTRACT_ERROR_CODES, 'offline', 'signed_out', 'not_deployed', 'network', 'cancelled', 'heic', 'unreadable']

export type ExtractOutcome = { ok: true; result: ExtractResult } | { ok: false; code: ScanErrorCode; retryAfter?: number }

/** The app gives up after this long; the function works to a shorter deadline (108 s), and the client's fetch allows 120 s. */
export const EXTRACT_TIMEOUT_MS = 115_000

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isExtractCode = (v: unknown): v is ExtractErrorCode => (EXTRACT_ERROR_CODES as readonly unknown[]).includes(v)
const seconds = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.ceil(v) : undefined)
/** A property of an error-like value (an Error, or the plain object the fake server answers with). */
const field = (v: unknown, key: 'name' | 'context'): unknown => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[key] : undefined)

/**
 * What an `invoke` error means. By `error.name` and `error.context.status`, never instanceof (the demo's fake server
 * can't build functions-js classes). A function answer carries its code in its JSON body; the platform's own answers
 * (a function not deployed, a relay down) are told by their status.
 */
export async function classifyInvokeError(error: unknown, signal?: AbortSignal): Promise<{ code: ScanErrorCode; retryAfter?: number }> {
  const name = field(error, 'name')
  const context = field(error, 'context')
  if (name === 'FunctionsHttpError') {
    const res = context as { status?: unknown; json?: () => Promise<unknown>; headers?: { get(name: string): string | null } } | undefined
    const status = typeof res?.status === 'number' ? res.status : 0
    const json = typeof res?.json === 'function' ? await res.json().catch(() => null) : null
    if (isRecord(json) && isExtractCode(json.code)) {
      const retryAfter = seconds(json.retryAfter)
      return retryAfter === undefined ? { code: json.code } : { code: json.code, retryAfter }
    }
    if (status === 404) return { code: 'not_deployed' }
    if (status === 401) return { code: 'unauthorized' }
    if (status === 402) return { code: 'limit_reached' }
    if (status === 413) return { code: 'too_large' }
    if (status === 429) {
      const retryAfter = seconds(Number(res?.headers?.get?.('Retry-After')))
      return retryAfter === undefined ? { code: 'rate_limited' } : { code: 'rate_limited', retryAfter }
    }
    if (status >= 500) return { code: 'unavailable' }
    return { code: 'bad_request' }
  }
  if (name === 'FunctionsRelayError') return { code: 'unavailable' }
  if (name === 'FunctionsFetchError') {
    if (signal?.aborted) return { code: 'cancelled' }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return { code: 'offline' }
    // The request's own timeout (functions-js aborts it after EXTRACT_TIMEOUT_MS, or the client's fetch after 120 s).
    if (field(context, 'name') === 'AbortError') return { code: 'timeout' }
    return { code: 'network' }
  }
  return { code: 'network' }
}

/**
 * Reads one image. `signal`: the sheet's Cancel (or its closing); an answer that comes after it is dropped (cancelled),
 * so a late answer adds nothing. `asUser`: the user the sheet is open for; another account's session counts as none.
 */
export async function extractExpenses(body: ExtractRequest, opts: { signal?: AbortSignal; asUser?: string } = {}): Promise<ExtractOutcome> {
  const { signal, asUser } = opts
  if (signal?.aborted) return { ok: false, code: 'cancelled' }
  try {
    await signedInUserId(asUser)
  } catch (err) {
    if (err instanceof SignedOutError) return { ok: false, code: 'signed_out' }
    return { ok: false, code: isNetworkError(err) ? 'offline' : 'network' }
  }
  if (signal?.aborted) return { ok: false, code: 'cancelled' }

  let data: unknown
  let error: unknown
  try {
    ;({ data, error } = await supabase.functions.invoke(EXTRACT_FUNCTION, { body, timeout: EXTRACT_TIMEOUT_MS, signal }))
  } catch (err) {
    error = err
  }
  if (signal?.aborted) return { ok: false, code: 'cancelled' }
  if (error) return { ok: false, ...(await classifyInvokeError(error, signal)) }
  if (isRecord(data) && data.ok === false) {
    if (!isExtractCode(data.code)) return { ok: false, code: 'bad_output' }
    const retryAfter = seconds(data.retryAfter)
    return retryAfter === undefined ? { ok: false, code: data.code } : { ok: false, code: data.code, retryAfter }
  }
  // `sample` (the demo's canned answer) is honoured only from the fake backend.
  const result = normalizeExtraction(data, { today: body.today, lang: body.lang, allowSample: isFakeBackend })
  return result === null ? { ok: false, code: 'bad_output' } : { ok: true, result }
}
