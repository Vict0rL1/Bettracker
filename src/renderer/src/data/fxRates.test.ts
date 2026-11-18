import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FX_FRESH_MS, FX_ORIGIN, readCache } from '../lib/fx'
import { createRates, FX_CACHE_KEY, FX_TIMEOUT_MS, type RatesDeps } from './fxRates'
import { clearUserData } from './offline'
import { evictExpendable } from './store'

const TODAY = '2026-11-18'
const NOW = Date.parse('2026-11-18T15:00:00.000Z')

interface Call {
  url: string
  init: RequestInit | undefined
}

/** A service that answers what the test says, and remembers what it was asked. */
function service(reply: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    return Promise.resolve().then(() => reply(url, init))
  }) as typeof fetch
  return { calls, fetch: fetchFn }
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const rate = (value: number, date: string, base = 'USD', to = 'CAD'): Response => json({ amount: 1.0, base, date, rates: { [to]: value } })

/** A fetch that never answers until its signal aborts (then fails as fetch does). */
const hangs = (_url: string, init?: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
  })

function rates(s: { fetch: typeof fetch }, over: Partial<RatesDeps> = {}) {
  const clock = { now: NOW, online: true }
  const made = createRates({ fetch: s.fetch, now: () => clock.now, today: () => TODAY, online: () => clock.online, ...over })
  return { ...made, clock }
}

const stored = () => readCache(JSON.parse(localStorage.getItem(FX_CACHE_KEY) ?? 'null'))

beforeEach(() => localStorage.clear())

describe('getRate — asking the service', () => {
  it('asks for a past day by date and gives the rate and the day it is of', async () => {
    const s = service(() => rate(1.4034, '2026-11-13'))
    const { getRate } = rates(s)
    expect(await getRate('USD', 'CAD', '2026-11-13')).toEqual({ ok: true, rate: 1.4034, asOf: '2026-11-13', source: 'service' })
    expect(s.calls.map((c) => c.url)).toEqual(['https://api.frankfurter.dev/v1/2026-11-13?base=USD&symbols=CAD'])
  })

  it('asks for the latest for today and for a later day', async () => {
    const s = service(() => rate(1.41, '2026-11-18'))
    const { getRate } = rates(s)
    expect(await getRate('USD', 'CAD', TODAY)).toMatchObject({ ok: true, rate: 1.41, source: 'service' })
    expect(s.calls[0].url).toBe('https://api.frankfurter.dev/v1/latest?base=USD&symbols=CAD')
    // A later day is today's rate: found in the cache, not asked for again.
    expect(await getRate('USD', 'CAD', '2026-12-24')).toMatchObject({ ok: true, rate: 1.41, source: 'cache' })
    expect(s.calls).toHaveLength(1)
  })

  it('a weekend answers with the business day before it, and says so', async () => {
    const s = service(() => rate(1.4034, '2026-11-13'))
    const { getRate } = rates(s)
    expect(await getRate('USD', 'CAD', '2026-11-14')).toEqual({ ok: true, rate: 1.4034, asOf: '2026-11-13', source: 'service' })
  })

  it('sends two currency codes and a date and nothing else: no credentials, no referrer, no header, not the Supabase client', async () => {
    const s = service(() => rate(1.4034, '2026-11-13'))
    await rates(s).getRate('USD', 'CAD', '2026-11-13')
    const { url, init } = s.calls[0]
    expect(init?.credentials).toBe('omit')
    expect(init?.referrerPolicy).toBe('no-referrer')
    expect(init?.method).toBe('GET')
    expect(init?.headers).toBeUndefined()
    expect(init?.body).toBeUndefined()
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(Object.keys(init ?? {}).sort()).toEqual(['credentials', 'method', 'referrerPolicy', 'signal'])
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://api.frankfurter.dev/v1/2026-11-13')
    expect(Object.fromEntries(u.searchParams)).toEqual({ base: 'USD', symbols: 'CAD' })
  })

  it('never asks for what is no pair or no date', async () => {
    const s = service(() => rate(1.4, TODAY))
    const { getRate } = rates(s)
    expect(await getRate('usd', 'CAD', TODAY)).toEqual({ ok: false, reason: 'unsupported' })
    expect(await getRate('USD', 'DOLLARS', TODAY)).toEqual({ ok: false, reason: 'unsupported' })
    expect(await getRate('USD', 'CAD', '2026-02-30')).toEqual({ ok: false, reason: 'unavailable' })
    expect(await getRate('USD', 'CAD', '')).toEqual({ ok: false, reason: 'unavailable' })
    expect(s.calls).toEqual([])
  })

  it('the same currency is 1, without asking', async () => {
    const s = service(() => rate(9, TODAY))
    expect(await rates(s).getRate('CAD', 'CAD', '2026-11-13')).toEqual({ ok: true, rate: 1, asOf: '2026-11-13', source: 'cache' })
    expect(s.calls).toEqual([])
  })
})

describe('getRate — the cache', () => {
  it('keeps what it fetched under one device-wide key, and uses it without asking again', async () => {
    const s = service(() => rate(1.4034, '2026-11-13'))
    const { getRate } = rates(s)
    await getRate('USD', 'CAD', '2026-11-13')
    expect(localStorage.length).toBe(1)
    expect(localStorage.key(0)).toBe('bettracker:fx')
    expect(stored().rates).toEqual({ 'USD>CAD@2026-11-13': { rate: 1.4034, asOf: '2026-11-13', at: NOW } })
    expect(await getRate('USD', 'CAD', '2026-11-13')).toEqual({ ok: true, rate: 1.4034, asOf: '2026-11-13', source: 'cache' })
    expect(s.calls).toHaveLength(1)
  })

  it('another window’s (or an earlier session’s) rate is found too', async () => {
    const first = service(() => rate(1.4034, '2026-11-13'))
    await rates(first).getRate('USD', 'CAD', '2026-11-13')
    const second = service(() => rate(9.99, '2026-11-13'))
    expect(await rates(second).getRate('USD', 'CAD', '2026-11-13')).toMatchObject({ rate: 1.4034, source: 'cache' })
    expect(second.calls).toEqual([])
  })

  it('a rate that may still be replaced (this morning’s latest) is asked for again after six hours', async () => {
    let answer = rate(1.4034, '2026-11-17')
    const s = service(() => answer.clone())
    const { getRate, clock } = rates(s)
    expect(await getRate('USD', 'CAD', TODAY)).toMatchObject({ rate: 1.4034, asOf: '2026-11-17', source: 'service' })
    clock.now = NOW + FX_FRESH_MS - 1
    expect(await getRate('USD', 'CAD', TODAY)).toMatchObject({ rate: 1.4034, source: 'cache' })
    expect(s.calls).toHaveLength(1)
    clock.now = NOW + FX_FRESH_MS
    answer = rate(1.4101, '2026-11-18')
    expect(await getRate('USD', 'CAD', TODAY)).toEqual({ ok: true, rate: 1.4101, asOf: '2026-11-18', source: 'service' })
    expect(s.calls).toHaveLength(2)
    // Today's own rate is settled: never asked for again.
    clock.now = NOW + 10 * FX_FRESH_MS
    expect(await getRate('USD', 'CAD', TODAY)).toMatchObject({ rate: 1.4101, source: 'cache' })
    expect(s.calls).toHaveLength(2)
  })

  it('still works where storage can keep nothing: this session remembers', async () => {
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    try {
      const s = service(() => rate(1.4034, '2026-11-13'))
      const { getRate } = rates(s)
      expect(await getRate('USD', 'CAD', '2026-11-13')).toMatchObject({ ok: true, source: 'service' })
      expect(await getRate('USD', 'CAD', '2026-11-13')).toMatchObject({ ok: true, rate: 1.4034, source: 'cache' })
      expect(s.calls).toHaveLength(1)
    } finally {
      setItem.mockRestore()
    }
  })

  it('a cache that is not one (another version, hand-edited) is ignored, not trusted', async () => {
    localStorage.setItem(FX_CACHE_KEY, JSON.stringify({ v: 1, rates: { 'USD>CAD@2026-11-13': { rate: -3, asOf: '2026-11-13', at: NOW } } }))
    const s = service(() => rate(1.4034, '2026-11-13'))
    expect(await rates(s).getRate('USD', 'CAD', '2026-11-13')).toMatchObject({ rate: 1.4034, source: 'service' })
    localStorage.setItem(FX_CACHE_KEY, '{not json')
    expect(await rates(service(() => rate(1.5, '2026-11-13'))).getRate('USD', 'CAD', '2026-11-13')).toMatchObject({ rate: 1.5, source: 'service' })
  })

  it('is no one’s data: signing out leaves it, and it is dropped with the other caches when storage is full', async () => {
    const s = service(() => rate(1.4034, '2026-11-13'))
    await rates(s).getRate('USD', 'CAD', '2026-11-13')
    clearUserData('user-1')
    expect(localStorage.getItem(FX_CACHE_KEY)).not.toBeNull()
    expect(FX_CACHE_KEY).not.toContain('user')
    expect(evictExpendable()).toBe(1)
    expect(localStorage.getItem(FX_CACHE_KEY)).toBeNull()
  })
})

describe('getRate — when the service can’t give one', () => {
  it('offline with nothing saved: says so, without trying', async () => {
    const s = service(() => rate(1.4, TODAY))
    const { getRate } = rates(s, { online: () => false })
    expect(await getRate('USD', 'CAD', '2026-11-13')).toEqual({ ok: false, reason: 'offline' })
    expect(s.calls).toEqual([])
  })

  it('offline with a rate of the pair saved: converts with the newest one, and says which day it is of', async () => {
    const s = service((url) => (url.includes('2026-11-10') ? rate(1.39, '2026-11-10') : rate(1.4034, '2026-11-13')))
    const { getRate, clock } = rates(s)
    await getRate('USD', 'CAD', '2026-11-10')
    await getRate('USD', 'CAD', '2026-11-13')
    clock.online = false
    expect(await getRate('USD', 'CAD', '2026-11-17')).toEqual({ ok: true, rate: 1.4034, asOf: '2026-11-13', source: 'last' })
    // Another pair has nothing saved.
    expect(await getRate('EUR', 'CAD', '2026-11-17')).toEqual({ ok: false, reason: 'offline' })
    expect(await getRate('CAD', 'USD', '2026-11-17')).toEqual({ ok: false, reason: 'offline' })
    expect(s.calls).toHaveLength(2)
  })

  it('a failed request (no route, a block) falls back the same way, as unavailable when nothing is saved', async () => {
    const down = service(() => {
      throw new TypeError('Failed to fetch')
    })
    expect(await rates(down).getRate('USD', 'CAD', '2026-11-13')).toEqual({ ok: false, reason: 'unavailable' })
    const s = service(() => rate(1.4034, '2026-11-13'))
    await rates(s).getRate('USD', 'CAD', '2026-11-13')
    expect(await rates(down).getRate('USD', 'CAD', '2026-11-17')).toEqual({ ok: true, rate: 1.4034, asOf: '2026-11-13', source: 'last' })
  })

  it('a request that fails because the connection just went is offline', async () => {
    const clock = { online: true }
    const s = service(() => {
      clock.online = false
      throw new TypeError('Failed to fetch')
    })
    const { getRate } = createRates({ fetch: s.fetch, now: () => NOW, today: () => TODAY, online: () => clock.online })
    expect(await getRate('USD', 'CAD', '2026-11-13')).toEqual({ ok: false, reason: 'offline' })
  })

  it('a stale rate of that very day is used when the service can’t be asked again', async () => {
    const s = service(() => rate(1.4034, '2026-11-17'))
    const { getRate, clock } = rates(s)
    await getRate('USD', 'CAD', TODAY)
    clock.now = NOW + FX_FRESH_MS + 1
    clock.online = false
    expect(await getRate('USD', 'CAD', TODAY)).toEqual({ ok: true, rate: 1.4034, asOf: '2026-11-17', source: 'cache' })
  })

  it('a 5xx, an answer that is no JSON and an answer of another shape are unavailable, and nothing is saved', async () => {
    for (const reply of [() => json({ message: 'oops' }, 500), () => json({}, 503), () => new Response('<html>', { status: 200 }), () => json({ base: 'USD', date: '2026-11-13', rates: { CAD: '1.4' } }), () => json({ base: 'EUR', date: '2026-11-13', rates: { CAD: 1.4 } }), () => json([])]) {
      localStorage.clear()
      expect(await rates(service(reply)).getRate('USD', 'CAD', '2026-11-13')).toEqual({ ok: false, reason: 'unavailable' })
      expect(localStorage.getItem(FX_CACHE_KEY)).toBeNull()
    }
  })

  it('a rate limit or a server timeout is unavailable, not "this pair doesn’t exist"', async () => {
    let status = 429
    const s = service(() => (status === 200 ? rate(1.4034, '2026-11-13') : json({ message: 'slow down' }, status)))
    const { getRate } = rates(s)
    expect(await getRate('USD', 'CAD', '2026-11-13')).toEqual({ ok: false, reason: 'unavailable' })
    status = 408
    expect(await getRate('USD', 'CAD', '2026-11-13')).toEqual({ ok: false, reason: 'unavailable' })
    // Asked again the next time, and answered.
    status = 200
    expect(await getRate('USD', 'CAD', '2026-11-13')).toMatchObject({ ok: true, rate: 1.4034, source: 'service' })
    expect(s.calls).toHaveLength(3)
  })

  it('a pair the service doesn’t have (4xx) is unsupported, remembered for the session and not asked for again', async () => {
    const s = service(() => json({ message: 'not found' }, 404))
    const { getRate } = rates(s)
    expect(await getRate('USD', 'COP', '2026-11-13')).toEqual({ ok: false, reason: 'unsupported' })
    expect(await getRate('USD', 'COP', '2026-11-10')).toEqual({ ok: false, reason: 'unsupported' })
    expect(await getRate('USD', 'COP', TODAY)).toEqual({ ok: false, reason: 'unsupported' })
    expect(s.calls).toHaveLength(1)
    // Only that pair, that way round.
    await getRate('COP', 'USD', TODAY)
    await getRate('USD', 'CAD', TODAY)
    expect(s.calls).toHaveLength(3)
    // Not kept past the session: a new one asks again.
    expect(localStorage.getItem(FX_CACHE_KEY)).toBeNull()
    const again = service(() => json({ message: 'not found' }, 422))
    expect(await rates(again).getRate('USD', 'COP', TODAY)).toEqual({ ok: false, reason: 'unsupported' })
    expect(again.calls).toHaveLength(1)
  })

  it('a day older than the service’s first says nothing about the pair', async () => {
    const s = service((url) => (url.includes('1990') ? json({ message: 'not found' }, 404) : rate(1.4034, '2026-11-13')))
    const { getRate } = rates(s)
    expect(await getRate('USD', 'CAD', '1990-05-01')).toEqual({ ok: false, reason: 'unsupported' })
    expect(await getRate('USD', 'CAD', '2026-11-13')).toMatchObject({ ok: true, rate: 1.4034 })
  })
})

describe('getRate — giving up', () => {
  it('gives up after 8 seconds and falls back', async () => {
    expect(FX_TIMEOUT_MS).toBe(8000)
    vi.useFakeTimers()
    try {
      const s = service(hangs)
      const { getRate } = rates(s)
      const pending = getRate('USD', 'CAD', '2026-11-13')
      let done = false
      void pending.then(() => (done = true))
      await vi.advanceTimersByTimeAsync(7999)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await pending).toEqual({ ok: false, reason: 'unavailable' })
      expect(s.calls[0].init?.signal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an answer whose body never ends counts as none', async () => {
    vi.useFakeTimers()
    try {
      const s = service(
        (_url, init) =>
          ({
            ok: true,
            status: 200,
            json: () => hangs('', init)
          }) as unknown as Response
      )
      const pending = rates(s).getRate('USD', 'CAD', '2026-11-13')
      await vi.advanceTimersByTimeAsync(FX_TIMEOUT_MS)
      expect(await pending).toEqual({ ok: false, reason: 'unavailable' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops at once when the caller does (the date changed, the sheet closed), and saves nothing', async () => {
    const s = service(hangs)
    const { getRate } = rates(s)
    const controller = new AbortController()
    const pending = getRate('USD', 'CAD', '2026-11-13', { signal: controller.signal })
    await Promise.resolve()
    controller.abort()
    expect(await pending).toEqual({ ok: false, reason: 'unavailable' })
    expect(s.calls[0].init?.signal?.aborted).toBe(true)
    expect(localStorage.getItem(FX_CACHE_KEY)).toBeNull()
  })

  it('a caller already gone never reaches the service', async () => {
    const s = service(() => rate(1.4, TODAY))
    const controller = new AbortController()
    controller.abort()
    expect(await rates(s).getRate('USD', 'CAD', '2026-11-13', { signal: controller.signal })).toEqual({ ok: false, reason: 'unavailable' })
    expect(s.calls).toEqual([])
  })

  it('an abort does not hand out the saved rate as if nothing happened: the outcome is to be ignored', async () => {
    const ok = service(() => rate(1.4034, '2026-11-13'))
    await rates(ok).getRate('USD', 'CAD', '2026-11-13')
    const s = service(hangs)
    const controller = new AbortController()
    const pending = rates(s).getRate('USD', 'CAD', '2026-11-17', { signal: controller.signal })
    await Promise.resolve()
    controller.abort()
    expect(await pending).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('never throws, whatever the service or the storage does', async () => {
    const getItem = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage is off')
    })
    try {
      const s = service(() => rate(1.4034, '2026-11-13'))
      await expect(rates(s).getRate('USD', 'CAD', '2026-11-13')).resolves.toMatchObject({ ok: true, rate: 1.4034 })
    } finally {
      getItem.mockRestore()
    }
    localStorage.clear()
    const broken = createRates({
      fetch: (() => {
        throw new Error('sync throw')
      }) as unknown as typeof fetch,
      now: () => NOW,
      today: () => TODAY,
      online: () => true
    })
    await expect(broken.getRate('USD', 'CAD', '2026-11-13')).resolves.toEqual({ ok: false, reason: 'unavailable' })
    const noClock = createRates({
      fetch: service(() => rate(1.4, TODAY)).fetch,
      today: () => {
        throw new Error('no clock')
      }
    })
    await expect(noClock.getRate('USD', 'CAD', '2026-11-13')).resolves.toEqual({ ok: false, reason: 'unavailable' })
  })
})

describe('the page lets the request out', () => {
  it('the content security policy allows the rate service’s origin, and no other third party', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
    const connect = /connect-src ([^;]+);/.exec(html)?.[1].split(/\s+/) ?? []
    expect(connect).toContain(FX_ORIGIN)
    // Supabase, the rate service, and this machine in development: nothing else.
    expect(connect.filter((src) => !src.includes('supabase.co') && !src.includes('localhost') && src !== "'self'")).toEqual([FX_ORIGIN])
  })
})
