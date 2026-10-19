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
