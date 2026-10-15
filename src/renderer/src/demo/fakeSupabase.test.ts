import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeSupabase } from './fakeSupabase'

interface Result {
  data: unknown
  error: { message: string; code: string } | null
  count?: number
}
interface Chain extends PromiseLike<Result> {
  select(): Chain
  eq(column: string, value: unknown): Chain
  lte(column: string, value: unknown): Chain
  maybeSingle(): Chain
  insert(payload: unknown): Chain
  update(payload: unknown): Chain
  upsert(payload: unknown): Chain
  delete(): Chain
}
interface Fake {
  auth: {
    getSession(): Promise<{ data: { session: { user: { id: string } } | null } }>
    onAuthStateChange(fn: (event: string, session: unknown) => void): { data: { subscription: { unsubscribe(): void } } }
    signInWithPassword(creds: { email: string; password: string }): Promise<{ data: { session: unknown }; error: null }>
    signOut(): Promise<unknown>
  }
  from(table: string): Chain
}

const USER = { id: 'u1', email: 'demo@example.com' }

function install(prefix: string, demo: boolean): Fake {
  installFakeSupabase({ prefix, user: USER, demo })
  return (globalThis as unknown as { __supabaseMock: Fake }).__supabaseMock
}

const migrate = (prefix: string, which: ('004' | '005')[] = ['004', '005']): void => {
  if (which.includes('004')) localStorage.setItem(`${prefix}migrated`, '1')
  if (which.includes('005')) localStorage.setItem(`${prefix}migrated-005`, '1')
}

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('window', globalThis)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fake Supabase: signing in and out', () => {
  it('the demo starts signed in, signs out for good, and takes any email and password back in', async () => {
    const fake = install('demo:', true)
    const events: string[] = []
    fake.auth.onAuthStateChange((event) => events.push(event))
    expect((await fake.auth.getSession()).data.session?.user.id).toBe('u1')

    await fake.auth.signOut()
    expect(events).toEqual(['SIGNED_OUT'])
    expect((await fake.auth.getSession()).data.session).toBeNull()
    // A reload installs it again: still signed out.
    expect((await install('demo:', true).auth.getSession()).data.session).toBeNull()

    const signedIn = await fake.auth.signInWithPassword({ email: 'anyone@example.com', password: 'x' })
    expect(signedIn.error).toBeNull()
    expect(events).toEqual(['SIGNED_OUT', 'SIGNED_IN'])
    expect((await fake.auth.getSession()).data.session?.user.id).toBe('u1')
  })

  it('an unsubscribed listener hears nothing', async () => {
    const fake = install('demo:', true)
    const events: string[] = []
    fake.auth.onAuthStateChange((event) => events.push(event)).data.subscription.unsubscribe()
    await fake.auth.signOut()
    expect(events).toEqual([])
  })

  it('the e2e session never ends', async () => {
    const fake = install('e2e:', false)
    await fake.auth.signOut()
    expect((await fake.auth.getSession()).data.session?.user.id).toBe('u1')
  })
})

describe('fake Supabase: a database missing migrations', () => {
  it('without 004, bets read and delete but every add or edit is refused, and there are no settings', async () => {
    const fake = install('e2e:', false)
    localStorage.setItem('e2e:rows', JSON.stringify([{ id: 'a', updated_at: '2026-01-01T00:00:00.000Z' }]))
    expect((await fake.from('entries').select()).data).toHaveLength(1)
    expect((await fake.from('entries').insert({ id: 'b' })).error?.code).toBe('PGRST204')
    expect((await fake.from('entries').update({ note: 'x' }).eq('id', 'a')).error?.code).toBe('PGRST204')
    expect((await fake.from('user_settings').select().maybeSingle()).error?.code).toBe('PGRST205')
    expect((await fake.from('entries').delete().eq('id', 'a')).count).toBe(1)
  })

  it('without 005, every request for deposits and withdrawals is refused, reads too', async () => {
    const fake = install('e2e:', false)
    migrate('e2e:', ['004'])
    expect((await fake.from('bankroll_moves').select()).error?.code).toBe('PGRST205')
    expect((await fake.from('bankroll_moves').delete().eq('id', 'm')).error?.code).toBe('PGRST205')
  })
})

describe('fake Supabase: an up-to-date database', () => {
  it('adds, refuses a duplicate id, and stamps what it writes', async () => {
    const fake = install('demo:', true)
    migrate('demo:')
    const added = await fake.from('entries').insert({ id: 'a', amount: 5 }).select().maybeSingle()
    expect(added.error).toBeNull()
    expect(added.data).toMatchObject({ id: 'a', amount: 5 })
    expect(typeof (added.data as { updated_at: unknown }).updated_at).toBe('string')
    expect((await fake.from('entries').insert({ id: 'a' })).error?.code).toBe('23505')
    expect((await fake.from('entries').select().eq('id', 'a').maybeSingle()).data).toMatchObject({ id: 'a' })
  })

  it('applies an edit only over a row no newer than the edit (the conflict rule)', async () => {
    const fake = install('demo:', true)
    migrate('demo:')
    localStorage.setItem('demo:rows', JSON.stringify([{ id: 'a', note: '', updated_at: '2026-05-01T00:00:00.000Z' }]))
    const stale = await fake.from('entries').update({ note: 'old' }).eq('id', 'a').lte('updated_at', '2026-04-01T00:00:00.000Z')
    expect(stale).toMatchObject({ data: null, error: null })
    const fresh = await fake.from('entries').update({ note: 'new' }).eq('id', 'a').lte('updated_at', '2026-06-01T00:00:00.000Z')
    expect(fresh.data).toMatchObject({ note: 'new' })
    // An edit with no time is refused the way Postgres refuses it.
    expect((await fake.from('entries').update({ note: 'x' }).eq('id', 'a').lte('updated_at', undefined)).error?.code).toBe('22007')
  })

  it('upserts by id, keeping what the payload does not name', async () => {
    const fake = install('demo:', true)
    migrate('demo:')
    localStorage.setItem('demo:rows', JSON.stringify([{ id: 'a', note: 'keep', amount: 1 }]))
    const res = await fake.from('entries').upsert([{ id: 'a', amount: 2 }, { id: 'b', amount: 3 }])
    expect(res.count).toBe(2)
    const all = (await fake.from('entries').select()).data as { id: string; note?: string; amount: number }[]
    expect(all.find((r) => r.id === 'a')).toMatchObject({ note: 'keep', amount: 2 })
    expect(all.find((r) => r.id === 'b')).toMatchObject({ amount: 3 })
  })

  it('keeps one settings row: insert once, then edits under the conflict rule', async () => {
    const fake = install('demo:', true)
    migrate('demo:')
    expect((await fake.from('user_settings').select().maybeSingle()).data).toBeNull()
    const inserted = await fake.from('user_settings').insert({ user_id: 'u1', unit_size: 20, updated_at: '2026-05-01T00:00:00.000Z' })
    expect(inserted.data).toMatchObject({ odds_format: 'american', unit_size: 20 })
    expect((await fake.from('user_settings').insert({ user_id: 'u1' })).error?.code).toBe('23505')
    expect((await fake.from('user_settings').update({ unit_size: 5 }).eq('user_id', 'u1').lte('updated_at', '2026-04-01T00:00:00.000Z')).data).toBeNull()
    expect((await fake.from('user_settings').update({ unit_size: 25 }).eq('user_id', 'u1').lte('updated_at', '2026-06-01T00:00:00.000Z')).data).toMatchObject({ unit_size: 25 })
  })

  it('keeps deposits and withdrawals in their own table', async () => {
    const fake = install('demo:', true)
    migrate('demo:')
    await fake.from('bankroll_moves').insert({ id: 'm', amount: 100 })
    expect((await fake.from('bankroll_moves').insert({ id: 'm', amount: 1 })).error?.code).toBe('23505')
    expect((await fake.from('entries').select()).data).toEqual([])
    expect((await fake.from('bankroll_moves').delete().eq('id', 'm')).count).toBe(1)
    expect((await fake.from('bankroll_moves').select()).data).toEqual([])
  })

  it('counts the writes it answers, not the reads', async () => {
    const fake = install('e2e:', false)
    migrate('e2e:')
    await fake.from('entries').select()
    await fake.from('entries').insert({ id: 'a' })
    await fake.from('entries').delete().eq('id', 'a')
    expect(localStorage.getItem('e2e:writes')).toBe('2')
  })
})

describe('fake Supabase: no connection', () => {
  const failedFetch = { data: null, error: { message: 'TypeError: Failed to fetch', code: '' } }

  it('fails every request while the e2e connection is down', async () => {
    const fake = install('e2e:', false)
    migrate('e2e:')
    localStorage.setItem('e2e:down', '1')
    expect(await fake.from('entries').select()).toEqual(failedFetch)
  })

  it('in the demo, follows the browser going offline', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    const fake = install('demo:', true)
    migrate('demo:')
    expect(await fake.from('entries').insert({ id: 'a' })).toEqual(failedFetch)
    expect(localStorage.getItem('demo:rows')).toBeNull()
  })

  it('in the e2e harness, ignores the browser: only `down` takes the connection away', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    const fake = install('e2e:', false)
    migrate('e2e:')
    expect((await fake.from('entries').select()).error).toBeNull()
  })
})
