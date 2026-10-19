/**
 * fetch that gives up on a request whose answer has not come in full after
 * `ms`.
 *
 * A request can hang without failing (a connection dropped on the way, the
 * phone switching networks), and the queues are sent by one window at a time,
 * under a lock (see data/store.ts): one window waiting for ever would keep
 * every window from syncing. Given up, the request fails as one that never
 * reached the server does, so the change stays queued for the next try. A
 * plain abort, which supabase-js does not retry by itself. The answer's body
 * is read here, within the same time: an answer that stops halfway would
 * otherwise keep supabase-js reading it for ever.
 */
export function timeoutFetch(ms: number, base: typeof fetch = (input, init) => fetch(input, init)): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController()
    const outer = init?.signal
    const forward = (): void => controller.abort(outer?.reason)
    if (outer?.aborted) forward()
    else outer?.addEventListener('abort', forward, { once: true })
    const timer = setTimeout(() => controller.abort(), ms)
    try {
      const res = await base(input, { ...init, signal: controller.signal })
      // A status no Response can be made with (an opaque answer): as it is.
      if (res.status < 200 || res.status > 599) return res
      // These carry no body, and a Response made with one would throw.
      const body = [204, 205, 304].includes(res.status) ? null : await res.arrayBuffer()
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', forward)
    }
  }
}
