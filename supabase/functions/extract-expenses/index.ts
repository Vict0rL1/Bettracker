// The Expenses view's AI reader: one receipt photo or Apple Wallet screenshot
// in, the expenses it shows out. Stateless: the image is neither stored nor
// logged, and nothing is written to the database. Deploy and secrets: README,
// "AI reading of receipts". The prompt, schema and checks are shared with the
// app, which checks the answer again: ../_shared/expenseExtraction.ts is a
// byte-for-byte copy of src/shared/expenseExtraction.ts (`npm run
// sync:function` writes it; a unit test compares them), so everything the
// function needs is under supabase/functions and any way of deploying works.
//
// ANTHROPIC_API_KEY is a secret of this function (`supabase secrets set`):
// never in the app, never in a VITE_ variable (the app's build refuses one).
import Anthropic from 'npm:@anthropic-ai/sdk@1.8.0' // pinned: the newest release ≥ 7 days old when written (2026-11-18); see the README
import { createClient } from 'npm:@supabase/supabase-js@2.110.7'
import { corsHeaders } from 'npm:@supabase/supabase-js@2.110.7/cors'
import {
  EXTRACT_LIMITS,
  EXTRACT_MODEL,
  EXTRACT_STATUS,
  EXTRACTION_SCHEMA,
  EXTRACTION_SYSTEM,
  answerFromMessage,
  buildUserPrompt,
  codeForApiError,
  failBody,
  isAllowedUser,
  parseExtractRequest,
  type ApiErrorFacts,
  type ExtractErrorCode,
  type ExtractRequest
} from '../_shared/expenseExtraction.ts'

// supabase-js's own header list (a header a later supabase-js adds can't break the preflight); browsers cap max-age at 7200.
// Origin '*': the PWA's origin and Electron's file:// ("null"); auth is the bearer token, not cookies.
const CORS: Record<string, string> = { ...corsHeaders, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Max-Age': '7200' }
const reply = (body: unknown, status: number, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } })
const fail = (code: ExtractErrorCode, retryAfter?: number): Response =>
  reply(failBody(code, retryAfter ? { retryAfter } : undefined), EXTRACT_STATUS[code], retryAfter ? { 'Retry-After': String(retryAfter) } : {})

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const apiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
// No SDK retries (they would wait out a 429's retry-after and retry timeouts, outliving the app's 115 s and billing twice):
// the one retry below is ours, only for a quick transient failure.
const anthropic = apiKey ? new Anthropic({ apiKey, maxRetries: 0 }) : null
/** The whole call stays under the app's EXTRACT_TIMEOUT_MS (115 s), auth check included. */
const DEADLINE_MS = 108_000

/** Codes, sizes, timings and token counts only: never the image, a merchant or an amount. */
function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ fn: 'extract-expenses', ...fields }))
}

// Best effort, per isolate (isolates are recycled): it stops a loop or a second window, not a determined abuser.
// The hard cap is the Anthropic workspace's monthly spend limit (README).
const inflight = new Set<string>()
const recent = new Map<string, number[]>()
const WINDOW_MS = 10 * 60_000
const WINDOW_CALLS = 20
/** Seconds to wait, or null to go ahead (and count this call). */
function throttle(uid: string, now: number): number | null {
  if (inflight.has(uid)) return 5
  const calls = (recent.get(uid) ?? []).filter((t) => now - t < WINDOW_MS)
  recent.set(uid, calls)
  if (calls.length >= WINDOW_CALLS) return Math.max(1, Math.ceil((WINDOW_MS - (now - calls[0])) / 1000))
  calls.push(now)
  return null
}

type Who = { user: { id: string; email: string | null; confirmed: boolean } } | { code: ExtractErrorCode }
/** Who is asking. Built per request (never at module scope: a bad env must not stop the worker from booting). */
async function whoIs(req: Request, token: string): Promise<Who> {
  // The app's own publishable (or legacy anon) key, which supabase-js sends as `apikey` on every call; the platform default only
  // as a fallback. Safe: the URL is this project's and Auth checks both the key and the JWT. Survives the legacy keys' retirement.
  const apikey = req.headers.get('apikey') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  if (!SUPABASE_URL || !apikey) return { code: 'not_configured' }
  const auth = createClient(SUPABASE_URL, apikey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }) }
  })
  const { data, error } = await auth.auth.getUser(token)
  // Only Auth's "no" is "sign in again"; an outage or a timeout is "busy" (the UI must not push the user to sign out).
  if (error) return { code: error.status === 401 || error.status === 403 ? 'unauthorized' : 'unavailable' }
  const u = data.user
  if (!u || u.is_anonymous) return { code: 'unauthorized' }
  return { user: { id: u.id, email: u.email ?? null, confirmed: Boolean(u.email_confirmed_at) } }
}

/** The body, read up to the cap and no further: a chunked upload has no Content-Length to check first. */
async function readCapped(req: Request): Promise<string | null> {
  if (Number(req.headers.get('Content-Length') ?? 0) > EXTRACT_LIMITS.maxBodyChars) return null
  if (!req.body) return ''
  const reader = req.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > EXTRACT_LIMITS.maxBodyChars) {
      await reader.cancel()
      return null
    }
    parts.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const p of parts) {
    all.set(p, at)
    at += p.byteLength
  }
  return new TextDecoder().decode(all)
}

/** The SDK error as facts for codeForApiError. Most specific first: the abort and connection errors are APIErrors too. */
function factsOf(err: unknown): ApiErrorFacts {
  if (err instanceof Anthropic.APIUserAbortError) return { kind: 'abort' }
  if (err instanceof Anthropic.APIConnectionTimeoutError) return { kind: 'timeout' }
  if (err instanceof Anthropic.APIConnectionError) return { kind: 'connection' }
  if (err instanceof Anthropic.APIError) {
    const retry = Number(err.headers?.get('retry-after'))
    return { kind: 'api', status: err.status, type: err.type, errorCode: err.errorCode, retryAfter: Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : undefined }
  }
  return { kind: 'other' }
}

async function extract(req: Request, request: ExtractRequest, uid: string, chars: number, started: number): Promise<Response> {
  const params = {
    model: EXTRACT_MODEL,
    max_tokens: 16000,
    // On a policy decline the API re-runs the request on a fallback model it picks by the decline's category.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default' as const,
    // Opus 5.5 always thinks (adaptive): no `thinking` and no `temperature` (both would be refused). Effort set explicitly.
    output_config: { effort: 'medium' as const, format: { type: 'json_schema' as const, schema: EXTRACTION_SCHEMA as Record<string, unknown> } },
    system: EXTRACTION_SYSTEM,
    messages: [
      {
        role: 'user' as const,
        content: [
          { type: 'image' as const, source: { type: 'base64' as const, media_type: request.image.mediaType, data: request.image.data } },
          { type: 'text' as const, text: buildUserPrompt(request) }
        ]
      }
    ]
  }
  const who = uid.slice(0, 8)
  let msg: Awaited<ReturnType<NonNullable<typeof anthropic>['beta']['messages']['create']>>
  for (let attempt = 0; ; attempt++) {
    try {
      // req.signal: the client hung up (Cancel, sheet closed) → stop paying (best effort; depends on the edge runtime).
      msg = await anthropic!.beta.messages.create(params, { timeout: Math.max(5_000, DEADLINE_MS - (Date.now() - started)), signal: req.signal })
      break
    } catch (err) {
      const f = factsOf(err)
      // One quick retry for an overload or a dropped connection; never for a timeout (a slow image would time out again, billed twice)
      // and never a sleep on a 429 (the client disables Retry for retryAfter).
      const transient = f.kind === 'connection' || (f.kind === 'api' && f.status !== undefined && f.status >= 500 && f.status !== 504)
      if (attempt === 0 && transient && Date.now() - started < 15_000) {
        await new Promise((r) => setTimeout(r, 1_000))
        continue
      }
      const { code, retryAfter } = codeForApiError(f)
      log({ uid: who, ms: Date.now() - started, chars, code, status: f.status ?? null, type: f.type ?? null, errorCode: f.errorCode ?? null })
      return code === 'aborted' ? fail('internal') : fail(code, retryAfter)
    }
  }
  // stop_reason is checked before the content is read (a refusal or a cut-short answer is no answer): see answerFromMessage.
  const out = answerFromMessage(msg, { today: request.today, lang: request.lang })
  log({
    uid: who,
    ms: Date.now() - started,
    chars,
    model: msg.model,
    stop: msg.stop_reason,
    inTok: msg.usage.input_tokens,
    outTok: msg.usage.output_tokens,
    // usage covers the attempt that answered; a fallback attempt shows up in usage.iterations.
    fallback: (msg.usage.iterations ?? []).some((i) => i.type === 'fallback_message'),
    category: msg.stop_details?.category ?? null,
    code: out.ok ? 'ok' : out.code,
    rows: out.ok ? out.expenses.length : undefined
  })
  return out.ok ? reply(out, 200) : fail(out.code)
}

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') return reply(failBody('bad_request'), 405, { Allow: 'POST, OPTIONS' })
  const started = Date.now()

  // Who is asking: a signed-in, non-anonymous user on the allow list. Refusals are logged (abuse must be visible).
  const token = req.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) {
    log({ code: 'unauthorized', why: 'no-token' })
    return fail('unauthorized')
  }
  const who = await whoIs(req, token)
  if ('code' in who) {
    log({ code: who.code, ms: Date.now() - started })
    return fail(who.code)
  }
  const uid = who.user.id
  if (!isAllowedUser(uid, who.user.email, who.user.confirmed, Deno.env.get('EXTRACT_ALLOWED_USERS'))) {
    log({ uid: uid.slice(0, 8), code: 'not_allowed' })
    return fail('not_allowed')
  }
  if (!anthropic) return fail('not_configured')

  // What was sent: capped while it is read, checked before it is forwarded.
  const text = await readCapped(req)
  if (text === null) return fail('too_large')
  const parsed = parseExtractRequest(text)
  if (!parsed.ok) return fail(parsed.code)

  const wait = throttle(uid, Date.now())
  if (wait !== null) {
    log({ uid: uid.slice(0, 8), code: 'rate_limited', local: true })
    return fail('rate_limited', wait)
  }
  inflight.add(uid)
  try {
    return await extract(req, parsed.value, uid, text.length, started)
  } finally {
    inflight.delete(uid)
  }
}

// Anything thrown (a client disconnect while reading, a bug) still answers with CORS headers and a code, and is logged:
// a bare platform 500 has no CORS headers, so the browser would report it as a network failure.
Deno.serve((req) =>
  handle(req).catch((e) => {
    log({ code: 'internal', err: e instanceof Error ? e.name : typeof e })
    return fail('internal')
  })
)
