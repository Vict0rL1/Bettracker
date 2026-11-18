import { afterEach, describe, expect, it, vi } from 'vitest'

// lib/supabase.ts reads the two values once, when it loads: each test sets
// them and loads a fresh copy.
async function load(url: string, key: string) {
  vi.stubEnv('VITE_SUPABASE_URL', url)
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', key)
  vi.resetModules()
  return import('./supabase')
}

const PUBLISHABLE = ['sb', 'publishable', 'Ab3dEfGh-1jKl_mN0pQr'].join('_')

afterEach(() => vi.unstubAllEnvs())

describe('lib/supabase', () => {
  it('with a good pair, is configured', async () => {
    const m = await load('https://abcdefghijklmnopqrst.supabase.co', PUBLISHABLE)
    expect(m.isConfigured).toBe(true)
    expect(m.envProblems).toEqual([])
  })

  // supabase-js throws on such a URL; it used to throw right here, as the
  // page loaded, and the page stayed blank.
  it('with a URL that has no https://, loads anyway and hands the problem to the setup screen', async () => {
    const m = await load('abcdefghijklmnopqrst.supabase.co', PUBLISHABLE)
    expect(m.isConfigured).toBe(false)
    expect(m.envProblems).toEqual([{ code: 'url-no-https', fix: 'https://abcdefghijklmnopqrst.supabase.co' }])
  })

  it('never makes a client with a secret key', async () => {
    const m = await load('https://abcdefghijklmnopqrst.supabase.co', ['sb', 'secret', 'Ab3dEfGh'].join('_'))
    expect(m.isConfigured).toBe(false)
    expect(m.envProblems).toEqual([{ code: 'key-secret' }])
    expect(() => m.supabase.auth).toThrow(/not configured/)
  })

  it('with nothing set, shows the setup steps without a problem', async () => {
    const m = await load('', '')
    expect(m.isConfigured).toBe(false)
    expect(m.envProblems).toEqual([])
  })
})

describe('lib/supabase: how long a request may take', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** A network that never answers: each request fails only when its signal aborts. */
  function silentNetwork() {
    const aborted: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
            init?.signal?.addEventListener('abort', () => {
              aborted.push(new URL(url).pathname)
              reject(new DOMException('Aborted', 'AbortError'))
            })
          })
      )
    )
    return aborted
  }

  it('gives a database request 30 s and an Edge Function call 2 minutes, through the one client', async () => {
    const m = await load('https://abcdefghijklmnopqrst.supabase.co', PUBLISHABLE)
    expect(m.isFakeBackend).toBe(false)
    vi.useFakeTimers()
    const aborted = silentNetwork()
    const read = Promise.resolve(m.supabase.from('expenses').select('*'))
    const scan = m.supabase.functions.invoke('extract-expenses', { body: { v: 1 } })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(aborted).toEqual(['/rest/v1/expenses'])
    await vi.advanceTimersByTimeAsync(89_000)
    expect(aborted).toEqual(['/rest/v1/expenses'])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(aborted).toEqual(['/rest/v1/expenses', '/functions/v1/extract-expenses'])
    expect((await read).error).not.toBeNull()
    expect((await scan).error).toMatchObject({ name: 'FunctionsFetchError' })
  })
})
