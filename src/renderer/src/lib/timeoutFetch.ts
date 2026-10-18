/**
 * fetch that gives up on a request whose answer has not begun after `ms`.
 *
 * A request can hang without failing (a connection dropped on the way, the
 * phone switching networks), and the queues are sent by one window at a time,
 * under a lock (see data/store.ts): one window waiting for ever would keep
 * every window from syncing. Given up, the request fails as one that never
 * reached the server does, so the change stays queued for the next try. A
 * plain abort, which supabase-js does not retry by itself.
 */
export function timeoutFetch(ms: number, base: typeof fetch = (input, init) => fetch(input, init)): typeof fetch {
  return (input, init) => {
    const controller = new AbortController()
    const outer = init?.signal
    const forward = (): void => controller.abort(outer?.reason)
    if (outer?.aborted) forward()
    else outer?.addEventListener('abort', forward, { once: true })
    const timer = setTimeout(() => controller.abort(), ms)
    return base(input, { ...init, signal: controller.signal }).finally(() => {
      clearTimeout(timer)
      outer?.removeEventListener('abort', forward)
    })
  }
}
