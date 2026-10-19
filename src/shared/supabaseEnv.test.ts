import { describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { checkSupabaseEnv, envMessage, envProblemLines, envStrings, supabaseEnvCheck, type EnvCheck, type EnvProblem } from './supabaseEnv'

// Keys are put together here rather than written out, so no string in the
// repository looks like a real one (the CI secret scan reads the tests too).
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (claims: object, sig = 'A'.repeat(43), header: object = { alg: 'HS256', typ: 'JWT' }): string =>
  `${b64(header)}.${b64(claims)}.${sig}`

const REF = 'abcdefghijklmnopqrst'
const OTHER = 'zyxwvutsrqponmlkjihg'
const URL_OK = `https://${REF}.supabase.co`
const anon = (ref: string = REF): string => jwt({ iss: 'supabase', ref, role: 'anon', iat: 1700000000, exp: 2015000000 })
const serviceRole = jwt({ iss: 'supabase', ref: REF, role: 'service_role', iat: 1700000000, exp: 2015000000 })
const PUBLISHABLE = ['sb', 'publishable', 'Ab3dEfGh-1jKl_mN0pQr'].join('_')
const SECRET = ['sb', 'secret', 'x'.repeat(20)].join('_')

/** The problems found, or [] when the pair is fine (or unset). */
const problems = (url: string | undefined, key: string | undefined): EnvProblem[] => {
  const c = checkSupabaseEnv(url, key)
  return c.status === 'bad' ? c.problems : []
}
const codes = (url: string | undefined, key: string | undefined): string[] => problems(url, key).map((p) => p.code)

describe('checkSupabaseEnv: nothing set', () => {
  it('is "unset", not a problem: the app shows its setup steps', () => {
    expect(checkSupabaseEnv(undefined, undefined)).toEqual({ status: 'unset' })
    expect(checkSupabaseEnv('', '  ')).toEqual({ status: 'unset' })
  })

  it('half set is a problem, naming the half that is missing', () => {
    expect(codes(URL_OK, '')).toEqual(['key-missing'])
    expect(codes('', PUBLISHABLE)).toEqual(['url-missing'])
  })
})

describe('checkSupabaseEnv: what passes', () => {
  it.each<[string, string, string, EnvCheck]>([
    ['a project URL and its publishable key', URL_OK, PUBLISHABLE, { status: 'ok', legacyKey: false, warnings: [] }],
    ['the old anon key of the same project, flagged as old', URL_OK, anon(), { status: 'ok', legacyKey: true, warnings: [] }],
    ['a trailing slash', `${URL_OK}/`, PUBLISHABLE, { status: 'ok', legacyKey: false, warnings: [] }],
    ['capitals in the address', `https://${REF.toUpperCase()}.supabase.co`, anon(), { status: 'ok', legacyKey: true, warnings: [] }],
    ['spaces around both', `  ${URL_OK}  `, `  ${PUBLISHABLE}\n`, { status: 'ok', legacyKey: false, warnings: [] }],
    // `supabase start`: plain http on this machine, and keys without a ref.
    ['the CLI’s local stack', 'http://127.0.0.1:54321', jwt({ iss: 'supabase-demo', role: 'anon', exp: 1983812996 }), { status: 'ok', legacyKey: true, warnings: [] }],
    // A vanity subdomain is not the ref, so there is nothing to compare.
    ['a vanity subdomain', 'https://my-bets.supabase.co', anon(), { status: 'ok', legacyKey: true, warnings: [] }],
    ['a self-hosted Supabase under a path', 'https://example.com/supabase', anon(OTHER), { status: 'ok', legacyKey: true, warnings: [] }]
  ])('%s', (_name, url, key, expected) => {
    expect(checkSupabaseEnv(url, key)).toEqual(expected)
  })

  // Read as examples left in, they stopped working setups.
  it('takes words and brackets as an example only where an example puts them', () => {
    expect(codes('http://[::1]:54321', PUBLISHABLE)).toEqual([])
    expect(codes('https://example.com/project-ref', PUBLISHABLE)).toEqual([])
    expect(codes('https://your-projects.example.com', PUBLISHABLE)).toEqual([])
    expect(codes('https://mybettrackerdatabase.supabase.co', PUBLISHABLE)).toEqual([])
  })

  it('accepts only URLs that supabase-js accepts, and stops the ones it would throw on (a blank page)', () => {
    const make = (url: string) => () => createClient(url, PUBLISHABLE, { auth: { persistSession: false, autoRefreshToken: false } })
    for (const url of [URL_OK, `${URL_OK}/`, 'http://127.0.0.1:54321', 'https://my-bets.supabase.co', 'https://example.com/supabase']) {
      expect(codes(url, PUBLISHABLE), url).toEqual([])
      expect(make(url), url).not.toThrow()
    }
    for (const url of [`${REF}.supabase.co`, 'not a url', 'ftp://example.com', 'https://exa mple.com']) {
      expect(codes(url, PUBLISHABLE), url).toHaveLength(1)
      expect(make(url), url).toThrow(/supabaseUrl/)
    }
  })
})

describe('checkSupabaseEnv: the URL', () => {
  it.each([
    ['the example in .env.example', 'https://YOUR-PROJECT-ref.supabase.co'],
    ['a row of x', 'https://xxxxxxxx.supabase.co'],
    ['a row of x, without https', 'xxxxxxxx.supabase.co'],
    ['the docs’ example', 'https://xyzcompany.supabase.co'],
    ['a <ref> left in', 'https://<ref>.supabase.co']
  ])('the example still there: %s', (_name, url) => {
    expect(problems(url, PUBLISHABLE)).toEqual([{ code: 'url-example' }])
  })

  it('without https:// (supabase-js refuses it), says which address to use', () => {
    expect(problems(`${REF}.supabase.co`, PUBLISHABLE)).toEqual([{ code: 'url-no-https', fix: URL_OK }])
    expect(problems(`${REF}.supabase.co/`, PUBLISHABLE)).toEqual([{ code: 'url-no-https', fix: URL_OK }])
    expect(problems(`http://${REF}.supabase.co`, PUBLISHABLE)).toEqual([{ code: 'url-no-https', fix: URL_OK }])
  })

  it('the dashboard’s address, with the project URL when the ref is in it', () => {
    expect(problems(`https://supabase.com/dashboard/project/${REF}`, PUBLISHABLE)).toEqual([{ code: 'url-dashboard', fix: URL_OK }])
    expect(problems(`https://app.supabase.com/project/${REF}/settings/api`, PUBLISHABLE)).toEqual([{ code: 'url-dashboard', fix: URL_OK }])
    expect(problems('https://supabase.com/dashboard/projects', PUBLISHABLE)).toEqual([{ code: 'url-dashboard', fix: null }])
  })

  it('a database connection string: stopped, and its password never repeated', () => {
    const direct = `postgresql://postgres:hunter2-db-pass@db.${REF}.supabase.co:5432/postgres`
    const pooler = `postgresql://postgres.${REF}:hunter2-db-pass@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`
    expect(problems(direct, PUBLISHABLE)).toEqual([{ code: 'url-database', fix: URL_OK }])
    expect(problems(pooler, PUBLISHABLE)).toEqual([{ code: 'url-database', fix: URL_OK }])
    expect(problems('postgres://me:hunter2-db-pass@localhost/bets', PUBLISHABLE)).toEqual([{ code: 'url-database', fix: null }])
    for (const lang of ['en', 'es'] as const) {
      for (const url of [direct, pooler]) expect(envProblemLines(problems(url, PUBLISHABLE), lang).join(' ')).not.toContain('hunter2')
    }
  })

  it('an API path or anything else after the address: keeps only the address', () => {
    expect(problems(`${URL_OK}/rest/v1/`, PUBLISHABLE)).toEqual([{ code: 'url-path', fix: URL_OK }])
    expect(problems(`${URL_OK}/auth/v1/settings`, PUBLISHABLE)).toEqual([{ code: 'url-path', fix: URL_OK }])
    expect(problems(`${URL_OK}/project`, PUBLISHABLE)).toEqual([{ code: 'url-path', fix: URL_OK }])
    expect(problems(`${URL_OK}/?apikey=1`, PUBLISHABLE)).toEqual([{ code: 'url-path', fix: URL_OK }])
    // Self-hosted under a path: only the API part goes.
    expect(problems('https://example.com/supabase/rest/v1', PUBLISHABLE)).toEqual([{ code: 'url-path', fix: 'https://example.com/supabase' }])
  })

  it('not an address at all', () => {
    expect(problems('my project', PUBLISHABLE)).toEqual([{ code: 'url-invalid' }])
  })
})

describe('checkSupabaseEnv: the key', () => {
  it.each([
    ['the example in .env.example', 'your-anon-public-key'],
    ['a <placeholder>', '<anon-key>'],
    ['a row of x', 'xxxxxxxxxxxx']
  ])('the example still there: %s', (_name, key) => {
    expect(problems(URL_OK, key)).toEqual([{ code: 'key-example' }])
  })

  it.each([
    ['cut short', anon().slice(0, -1)],
    ['without its signature', anon().split('.').slice(0, 2).join('.')],
    ['only its start', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'],
    ['garbled', anon().replace('.', '.!')],
    ['with a space in it', `${anon().slice(0, 30)} ${anon().slice(30)}`],
    ['copied with "Bearer "', `Bearer ${anon()}`],
    ['in quotes inside the quotes', `'${anon()}'`],
    ['shortened with …', `${PUBLISHABLE.slice(0, 20)}…`],
    ['shortened with ...', `${PUBLISHABLE.slice(0, 20)}...`]
  ])('damaged: %s', (_name, key) => {
    expect(problems(URL_OK, key)).toEqual([{ code: 'key-damaged' }])
  })

  it('a secret key — sb_secret_ or service_role — is stopped, whatever else is wrong', () => {
    expect(problems(URL_OK, SECRET)).toEqual([{ code: 'key-secret' }])
    expect(problems(URL_OK, serviceRole)).toEqual([{ code: 'key-secret' }])
    expect(problems('https://xxxxxxxx.supabase.co', serviceRole)).toEqual([{ code: 'url-example' }, { code: 'key-secret' }])
  })

  it('a token for another role, such as a signed-in user’s', () => {
    expect(problems(URL_OK, jwt({ ref: REF, role: 'authenticated', sub: 'u1' }))).toEqual([{ code: 'key-role', role: 'authenticated' }])
    expect(problems(URL_OK, jwt({ ref: REF }))).toEqual([{ code: 'key-role', role: '?' }])
  })

  it('anything else is not a key (the JWT secret, the database password …)', () => {
    expect(problems(URL_OK, 'super-secret-jwt-token-with-at-least-32-characters')).toEqual([{ code: 'key-unknown' }])
    expect(problems(URL_OK, REF)).toEqual([{ code: 'key-unknown' }])
  })

  // A warning, not a stop: a vanity subdomain of 20 letters looks like a ref.
  it('an anon key from another project, what Supabase calls "Invalid API key", is said without stopping anything', () => {
    expect(checkSupabaseEnv(URL_OK, anon(OTHER))).toEqual({
      status: 'ok',
      legacyKey: true,
      warnings: [{ code: 'key-other-project', keyRef: OTHER, urlRef: REF }]
    })
    // Nothing to compare with a custom domain, a vanity subdomain or a broken URL.
    expect(checkSupabaseEnv('https://api.example.com', anon(OTHER))).toMatchObject({ status: 'ok', warnings: [] })
    expect(checkSupabaseEnv('https://my-bets.supabase.co', anon(OTHER))).toMatchObject({ status: 'ok', warnings: [] })
    expect(codes(`${URL_OK}/rest/v1`, anon(OTHER))).toEqual(['url-path'])
  })
})

describe('the messages', () => {
  const every: EnvProblem[] = [
    { code: 'url-missing' },
    { code: 'key-missing' },
    { code: 'url-example' },
    { code: 'url-no-https', fix: URL_OK },
    { code: 'url-dashboard', fix: URL_OK },
    { code: 'url-dashboard', fix: null },
    { code: 'url-database', fix: URL_OK },
    { code: 'url-database', fix: null },
    { code: 'url-path', fix: URL_OK },
    { code: 'url-invalid' },
    { code: 'key-example' },
    { code: 'key-secret' },
    { code: 'key-role', role: 'authenticated' },
    { code: 'key-damaged' },
    { code: 'key-unknown' },
    { code: 'key-other-project', keyRef: OTHER, urlRef: REF }
  ]

  it('every problem has words in both languages, with every placeholder filled', () => {
    for (const p of every) {
      const { key } = envMessage(p)
      expect(envStrings.en[key], key).toBeTruthy()
      expect(envStrings.es[key], key).toBeTruthy()
      for (const lang of ['en', 'es'] as const) {
        const [line] = envProblemLines([p], lang)
        expect(line, `${key} (${lang})`).not.toMatch(/\{\w+\}/)
      }
    }
  })

  it('name the variable and give the value to use', () => {
    const p: EnvProblem = { code: 'url-no-https', fix: URL_OK }
    expect(envProblemLines([p], 'en')).toEqual([`VITE_SUPABASE_URL has to start with https://. Use ${URL_OK}.`])
    expect(envProblemLines([p], 'es')).toEqual([`VITE_SUPABASE_URL tiene que empezar por https://. Usa ${URL_OK}.`])
    expect(envProblemLines([{ code: 'key-other-project', keyRef: OTHER, urlRef: REF }], 'es')[0]).toContain(
      `de otro proyecto de Supabase (${OTHER}), no del de VITE_SUPABASE_URL (${REF})`
    )
  })
})

describe('supabaseEnvCheck (the build)', () => {
  /** Runs the plugin's hook as Vite would, with this env. */
  function run(env: Record<string, string>, command: 'build' | 'serve' = 'build', mode = 'production') {
    const warn = vi.fn()
    const hook = supabaseEnvCheck('en').configResolved as (config: unknown) => void
    const go = () => hook({ command, mode, env, logger: { warn } })
    return { go, warn }
  }

  it('stops a build on a problem, saying what to fix and nothing else', () => {
    const { go } = run({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_ANON_KEY: serviceRole })
    expect(go).toThrow(/can’t be built with this \.env:\n {2}• VITE_SUPABASE_ANON_KEY is a secret key/)
    try {
      go()
    } catch (err) {
      // Vite prints the stack: here it is the message alone.
      expect((err as Error).stack).toBe((err as Error).message)
    }
  })

  it('in dev and preview, only warns: the app shows the problem itself', () => {
    const { go, warn } = run({ VITE_SUPABASE_URL: `${REF}.supabase.co`, VITE_SUPABASE_ANON_KEY: PUBLISHABLE }, 'serve', 'development')
    expect(go).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`VITE_SUPABASE_URL has to start with https://. Use ${URL_OK}.`))
  })

  it('leaves the demo alone: it has its own backend', () => {
    const { go, warn } = run({ VITE_SUPABASE_URL: 'nonsense', VITE_SUPABASE_ANON_KEY: SECRET }, 'build', 'demo')
    expect(go).not.toThrow()
    expect(warn).not.toHaveBeenCalled()
  })

  it('builds with a good pair: quietly with a publishable key, with a word about the old anon key', () => {
    const quiet = run({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_ANON_KEY: PUBLISHABLE })
    expect(quiet.go).not.toThrow()
    expect(quiet.warn).not.toHaveBeenCalled()
    const old = run({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_ANON_KEY: anon() })
    expect(old.go).not.toThrow()
    expect(old.warn).toHaveBeenCalledWith(expect.stringContaining('retiring the old keys by the end of 2026'))
  })

  it('builds with a key from another project, saying so', () => {
    const { go, warn } = run({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_ANON_KEY: anon(OTHER) })
    expect(go).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`from another Supabase project (${OTHER})`))
  })

  it('builds without a .env, saying that build opens on the setup screen', () => {
    const { go, warn } = run({})
    expect(go).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('will open on the setup screen'))
  })

  it('speaks Spanish when asked', () => {
    const warn = vi.fn()
    const hook = supabaseEnvCheck('es').configResolved as (config: unknown) => void
    expect(() => hook({ command: 'build', mode: 'production', env: { VITE_SUPABASE_URL: 'https://xxxxxxxx.supabase.co', VITE_SUPABASE_ANON_KEY: PUBLISHABLE }, logger: { warn } })).toThrow(
      /no se puede compilar con este \.env:\n {2}• VITE_SUPABASE_URL sigue siendo el ejemplo/
    )
  })
})
