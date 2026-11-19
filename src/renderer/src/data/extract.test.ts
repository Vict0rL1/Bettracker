import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtractRequest } from '../../../shared/expenseExtraction'

/** The client: a session, an `invoke` that answers what a test queues, and which backend it is. */
const state = vi.hoisted(() => ({
  session: { data: { session: { user: { id: 'user-1' } } as unknown }, error: null as unknown },
  fake: false,
  answer: (async () => ({ data: null, error: null })) as (name: string, opts: unknown) => Promise<{ data: unknown; error: unknown }>,
  invokes: [] as { name: string; opts: { body?: unknown; timeout?: number; signal?: AbortSignal } }[]
}))

vi.mock('../lib/supabase', () => ({
  get isFakeBackend() {
    return state.fake
  },
  supabase: {
    auth: { getSession: async () => state.session },
    functions: {
      invoke: (name: string, opts: { body?: unknown; timeout?: number; signal?: AbortSignal }) => {
        state.invokes.push({ name, opts })
        return state.answer(name, opts)
      }
    }
  }
}))

import { en } from '../lib/strings'
import { classifyInvokeError, EXTRACT_TIMEOUT_MS, extractExpenses, SCAN_ERROR_CODES } from './extract'

const BODY: ExtractRequest = {
  v: 1,
  image: { mediaType: 'image/jpeg', data: '/9j/4AAQSkZJRgABAQAAAQABAAD' },
  today: '2026-11-17',
  timeZone: 'Europe/Madrid',
  lang: 'es',
  currency: 'EUR',
  cards: []
}
const ROW = {
  date: '2026-11-16',
  amount: 4.5,
  currency: 'EUR',
  currencyBasis: 'code',
  chargedAmount: null,
  chargedCurrency: null,
  merchant: 'Café',
  category: 'coffee',
  cardLast4: null,
  cardHint: null,
  note: '',
  pending: false,
  confidence: 'high'
}
const ANSWER = { ok: true, kind: 'receipt', currency: 'EUR', expenses: [ROW], warnings: [] }

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const httpError = (res: Response) => ({ name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code', context: res })
const fetchError = (context: unknown) => ({ name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function', context })
const answerWith = (out: { data: unknown; error: unknown }) => {
  state.answer = async () => out
}

beforeEach(() => {
  state.session = { data: { session: { user: { id: 'user-1' } } }, error: null }
  state.fake = false
  state.invokes = []
  answerWith({ data: ANSWER, error: null })
})

afterEach(() => vi.unstubAllGlobals())

describe('extractExpenses', () => {
  it('calls the function with the request, its timeout and the signal, and checks the answer again', async () => {
    const signal = new AbortController().signal
    const out = await extractExpenses(BODY, { signal, asUser: 'user-1' })
    expect(state.invokes).toEqual([{ name: 'extract-expenses', opts: { body: BODY, timeout: EXTRACT_TIMEOUT_MS, signal } }])
    expect(EXTRACT_TIMEOUT_MS).toBe(115_000)
    expect(out).toEqual({ ok: true, result: { kind: 'receipt', currency: 'EUR', expenses: [ROW], warnings: [] } })
  })

  it('cleans the answer the way the function does (a date in the future is a guess)', async () => {
    answerWith({ data: { ...ANSWER, expenses: [{ ...ROW, date: '2026-11-18', merchant: 'Pay at https://x.y' }] }, error: null })
    const out = await extractExpenses(BODY)
    expect(out.ok && out.result.expenses[0]).toMatchObject({ date: null, confidence: 'low', merchant: 'Pay at [link]' })
  })

  it('keeps the demo’s `sample` only from the fake backend', async () => {
    answerWith({ data: { ...ANSWER, sample: true }, error: null })
    const real = await extractExpenses(BODY)
    expect(real.ok && real.result).toMatchObject({ kind: 'receipt' })
    expect(real.ok && real.result).not.toHaveProperty('sample')
    state.fake = true
    expect(await extractExpenses(BODY)).toMatchObject({ ok: true, result: { sample: true } })
  })

  it('an answer that isn’t the shape is bad output; one that says it failed keeps its code', async () => {
    answerWith({ data: 'Internal error', error: null })
    expect(await extractExpenses(BODY)).toEqual({ ok: false, code: 'bad_output' })
    answerWith({ data: { ok: false, code: 'rate_limited', message: 'x', retryAfter: 7 }, error: null })
    expect(await extractExpenses(BODY)).toEqual({ ok: false, code: 'rate_limited', retryAfter: 7 })
    answerWith({ data: { ok: false, code: 'nonsense' }, error: null })
    expect(await extractExpenses(BODY)).toEqual({ ok: false, code: 'bad_output' })
  })

  it('signed out: never calls the function', async () => {
    state.session = { data: { session: null }, error: null }
    expect(await extractExpenses(BODY)).toEqual({ ok: false, code: 'signed_out' })
    state.session = { data: { session: { user: { id: 'someone-else' } } }, error: null }
    expect(await extractExpenses(BODY, { asUser: 'user-1' })).toEqual({ ok: false, code: 'signed_out' })
    expect(state.invokes).toEqual([])
  })

  it('no connection to renew the session: offline, without a call', async () => {
    state.session = { data: { session: null }, error: new TypeError('Failed to fetch') }
    expect(await extractExpenses(BODY)).toEqual({ ok: false, code: 'offline' })
    expect(state.invokes).toEqual([])
  })

  it('cancelled before it starts, or answered after the cancel: cancelled, never a result', async () => {
    const before = new AbortController()
    before.abort()
    expect(await extractExpenses(BODY, { signal: before.signal })).toEqual({ ok: false, code: 'cancelled' })
    expect(state.invokes).toEqual([])

    const during = new AbortController()
    state.answer = async () => {
      during.abort()
      return { data: ANSWER, error: null }
    }
    expect(await extractExpenses(BODY, { signal: during.signal })).toEqual({ ok: false, code: 'cancelled' })
  })

  it('an invoke that throws is a failed request, not a crash', async () => {
    state.answer = async () => {
      throw new TypeError('boom')
    }
    expect(await extractExpenses(BODY)).toEqual({ ok: false, code: 'network' })
  })

  it('passes the function’s error code on', async () => {
    answerWith({ data: null, error: httpError(json(429, { ok: false, code: 'rate_limited', message: 'x', retryAfter: 2 })) })
    expect(await extractExpenses(BODY)).toEqual({ ok: false, code: 'rate_limited', retryAfter: 2 })
  })
})

describe('classifyInvokeError', () => {
  it.each([
    ['not_allowed', 403],
    ['limit_reached', 402],
    ['refused', 422],
    ['not_configured', 503],
    ['bad_output', 502],
    ['unsupported', 415]
  ])('the function’s own code %s', async (code, status) => {
    expect(await classifyInvokeError(httpError(json(status, { ok: false, code, message: 'x' })))).toEqual({ code })
  })

  it('with a wait, when the answer has one', async () => {
    expect(await classifyInvokeError(httpError(json(429, { ok: false, code: 'rate_limited', message: 'x', retryAfter: 2.5 })))).toEqual({ code: 'rate_limited', retryAfter: 3 })
    expect(await classifyInvokeError(httpError(json(429, 'Too many', { 'Retry-After': '9' })))).toEqual({ code: 'rate_limited', retryAfter: 9 })
    expect(await classifyInvokeError(httpError(json(429, 'Too many')))).toEqual({ code: 'rate_limited' })
  })

  it.each<[number, string]>([
    [404, 'not_deployed'],
    [401, 'unauthorized'],
    [402, 'limit_reached'],
    [413, 'too_large'],
    [500, 'unavailable'],
    [503, 'unavailable'],
    [400, 'bad_request'],
    [405, 'bad_request']
  ])('the platform’s answer %i (no code of ours) → %s', async (status, code) => {
    expect(await classifyInvokeError(httpError(json(status, '<html>Not here</html>')))).toEqual({ code })
    // The platform's own JSON ("NOT_FOUND") is not one of our codes either.
    expect(await classifyInvokeError(httpError(json(status, { code: 'NOT_FOUND', message: 'Requested function was not found' })))).toEqual({ code })
  })

  it('a relay error: the service is busy', async () => {
    expect(await classifyInvokeError({ name: 'FunctionsRelayError', message: 'Relay Error', context: new Response(null, { status: 502 }) })).toEqual({ code: 'unavailable' })
  })

  it('a request that never got an answer: cancelled, offline, timed out, or a network failure', async () => {
    const aborted = new AbortController()
    aborted.abort()
    expect(await classifyInvokeError(fetchError(new DOMException('Aborted', 'AbortError')), aborted.signal)).toEqual({ code: 'cancelled' })
    expect(await classifyInvokeError(fetchError(new DOMException('Aborted', 'AbortError')))).toEqual({ code: 'timeout' })
    expect(await classifyInvokeError(fetchError(new TypeError('Failed to fetch')))).toEqual({ code: 'network' })
    expect(await classifyInvokeError(fetchError({}))).toEqual({ code: 'network' })
    vi.stubGlobal('navigator', { onLine: false })
    expect(await classifyInvokeError(fetchError(new TypeError('Failed to fetch')))).toEqual({ code: 'offline' })
  })

  it('anything else is a network failure', async () => {
    expect(await classifyInvokeError(new Error('?'))).toEqual({ code: 'network' })
    expect(await classifyInvokeError(null)).toEqual({ code: 'network' })
    expect(await classifyInvokeError({ name: 'FunctionsHttpError', context: null })).toEqual({ code: 'bad_request' })
  })
})

describe('the words for every failure', () => {
  it('every code but cancelled (which shows nothing), and the "still loading" reason, has scan.err.<code>', () => {
    const dict = en as Record<string, string>
    for (const code of [...SCAN_ERROR_CODES.filter((c) => c !== 'cancelled'), 'loading']) expect(dict[`scan.err.${code}`], code).toBeTruthy()
    expect(new Set(SCAN_ERROR_CODES).size).toBe(SCAN_ERROR_CODES.length)
  })
})
