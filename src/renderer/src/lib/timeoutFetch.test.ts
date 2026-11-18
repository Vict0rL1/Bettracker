import { afterEach, describe, expect, it, vi } from 'vitest'
import { FUNCTION_TIMEOUT_MS, REQUEST_TIMEOUT_MS, requestTimeoutFor, timeoutFetch } from './timeoutFetch'

/** A fetch that answers only when told to, or fails when its signal aborts. */
function hanging() {
  let answer: (() => void) | null = null
  const base = vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        answer = () => resolve(new Response('[]'))
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')))
      })
  )
  return { base: base as unknown as typeof fetch, answer: () => answer?.() }
}

afterEach(() => vi.useRealTimers())

describe('timeoutFetch', () => {
  // A request that never answered kept the drain lock, and so every window's
  // sync, for as long as the window stayed open.
  it('gives up on a request with no answer after the time given, as an abort', async () => {
    vi.useFakeTimers()
    const h = hanging()
    const pending = timeoutFetch(30_000, h.base)('https://x.supabase.co/rest/v1/entries')
    const failed = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(30_000)
    await failed
  })

  it('leaves a request that answers in time alone', async () => {
    vi.useFakeTimers()
    const h = hanging()
    const pending = timeoutFetch(30_000, h.base)('https://x.supabase.co/rest/v1/entries')
    await vi.advanceTimersByTimeAsync(29_000)
    h.answer()
    expect((await pending).ok).toBe(true)
    // The timer is gone: nothing aborts the request later.
    expect(vi.getTimerCount()).toBe(0)
  })

  // The answer's headers came, then its body stopped: supabase-js read it for
  // ever, and the window kept its sync lock.
  it('gives up on an answer whose body stops coming, within the same time', async () => {
    vi.useFakeTimers()
    const stalls = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('[{"id":'))
          init?.signal?.addEventListener('abort', () => c.error(init.signal?.reason))
        }
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    }) as typeof fetch
    const pending = timeoutFetch(30_000, stalls)('https://x.supabase.co/rest/v1/entries')
    const failed = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(30_000)
    await failed
    expect(vi.getTimerCount()).toBe(0)
  })

  it('hands on the answer as it came: status, headers and body', async () => {
    const base = (async () => new Response('[{"id":1}]', { status: 206, statusText: 'Partial Content', headers: { 'content-range': '0-0/9' } })) as typeof fetch
    const res = await timeoutFetch(30_000, base)('https://x.supabase.co/rest/v1/entries')
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('0-0/9')
    expect(await res.json()).toEqual([{ id: 1 }])
    const empty = await timeoutFetch(30_000, (async () => new Response(null, { status: 204 })) as typeof fetch)('https://x.supabase.co/rest/v1/entries')
    expect(empty.status).toBe(204)
  })

  it('still aborts when the caller does', async () => {
    const h = hanging()
    const caller = new AbortController()
    const pending = timeoutFetch(30_000, h.base)('https://x.supabase.co/rest/v1/entries', { signal: caller.signal })
    caller.abort(new DOMException('Cancelled', 'AbortError'))
    await expect(pending).rejects.toMatchObject({ message: 'Cancelled' })
  })
})

describe('requestTimeoutFor', () => {
  // The AI reading of a receipt can take a minute; a database request that
  // long is a connection that has gone.
  it('gives an Edge Function call 2 minutes and everything else 30 s, however the request is given', () => {
    const fn = 'https://x.supabase.co/functions/v1/extract-expenses'
    const rest = 'https://x.supabase.co/rest/v1/expenses?select=*'
    expect(requestTimeoutFor(fn)).toBe(FUNCTION_TIMEOUT_MS)
    expect(requestTimeoutFor(new URL(fn))).toBe(FUNCTION_TIMEOUT_MS)
    expect(requestTimeoutFor(new Request(fn, { method: 'POST' }))).toBe(FUNCTION_TIMEOUT_MS)
    expect(requestTimeoutFor(rest)).toBe(REQUEST_TIMEOUT_MS)
    expect(requestTimeoutFor(new URL(rest))).toBe(REQUEST_TIMEOUT_MS)
    expect(requestTimeoutFor(new Request(rest))).toBe(REQUEST_TIMEOUT_MS)
    expect(requestTimeoutFor('https://x.supabase.co/auth/v1/token')).toBe(REQUEST_TIMEOUT_MS)
    expect([REQUEST_TIMEOUT_MS, FUNCTION_TIMEOUT_MS]).toEqual([30_000, 120_000])
  })
})
