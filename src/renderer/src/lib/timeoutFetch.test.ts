import { afterEach, describe, expect, it, vi } from 'vitest'
import { timeoutFetch } from './timeoutFetch'

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

  it('still aborts when the caller does', async () => {
    const h = hanging()
    const caller = new AbortController()
    const pending = timeoutFetch(30_000, h.base)('https://x.supabase.co/rest/v1/entries', { signal: caller.signal })
    caller.abort(new DOMException('Cancelled', 'AbortError'))
    await expect(pending).rejects.toMatchObject({ message: 'Cancelled' })
  })
})
