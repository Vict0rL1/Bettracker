import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as extraction from '../../../shared/expenseExtraction'
import { PAGE_SIZE, readAll } from '../data/readAll'
import { installFakeSupabase, type ExtractionContract } from './fakeSupabase'

interface Result {
  data: unknown
  error: { message: string; code: string } | null
  count?: number
  status?: number
}
interface Chain extends PromiseLike<Result> {
  select(columns?: string, opts?: unknown): Chain
  order(column: string): Chain
  range(from: number, to: number): Chain
  eq(column: string, value: unknown): Chain
  lte(column: string, value: unknown): Chain
  maybeSingle(): Chain
  insert(payload: unknown): Chain
  update(payload: unknown): Chain
  upsert(payload: unknown, opts?: { ignoreDuplicates?: boolean }): Chain
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
  functions: { invoke(name: string, opts?: { body?: unknown; signal?: AbortSignal }): Promise<Invoked> }
  __endSession(): void
}
/** What functions.invoke answers, as functions-js does: data, or an error with its name and context. */
interface Invoked {
  data: unknown
  error: { name: string; message: string; context: unknown } | null
}

const USER = { id: 'u1', email: 'demo@example.com' }

// Built from the function's source text alone, the way Playwright sends it to
// the page: a reference to anything outside its body fails here.
const isolated = new Function('cfg', `(${installFakeSupabase.toString()})(cfg)`) as typeof installFakeSupabase

function install(prefix: string, demo: boolean): Fake {
  isolated({ prefix, user: USER, demo })
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

    const signedIn = await fake.auth.signInWithPassword({ email: 'anyone@example.com', password: 'whatever' })
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

  it('signing in needs the connection, as with Supabase', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    const fake = install('demo:', true)
    await fake.auth.signOut()
    const events: string[] = []
    fake.auth.onAuthStateChange((event) => events.push(event))
    const res = await fake.auth.signInWithPassword({ email: 'anyone@example.com', password: 'whatever' })
    expect((res as unknown as Result).error?.message).toBe('Failed to fetch')
    expect(events).toEqual([])
    expect((await fake.auth.getSession()).data.session).toBeNull()
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

  it('applies an edit only over a row no newer than the edit (the conflict rule), and only to that row', async () => {
    const fake = install('demo:', true)
    migrate('demo:')
    const at = '2026-05-01T00:00:00.000Z'
    localStorage.setItem('demo:rows', JSON.stringify([{ id: 'a', note: '', updated_at: at }, { id: 'b', note: 'b', updated_at: at }]))
    const stale = await fake.from('entries').update({ note: 'old' }).eq('id', 'a').lte('updated_at', '2026-04-01T00:00:00.000Z')
    expect(stale).toMatchObject({ data: null, error: null })
    // Exactly as old as the row still applies: the rule is `<=`.
    const same = await fake.from('entries').update({ note: 'same' }).eq('id', 'a').lte('updated_at', at)
    expect(same.data).toMatchObject({ note: 'same' })
    const fresh = await fake.from('entries').update({ note: 'new' }).eq('id', 'a').lte('updated_at', '2026-06-01T00:00:00.000Z')
    expect(fresh.data).toMatchObject({ note: 'new' })
    expect((await fake.from('entries').select().eq('id', 'b').maybeSingle()).data).toMatchObject({ note: 'b' })
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
    expect((await fake.from('user_settings').update({ unit_size: 10 }).eq('user_id', 'u1').lte('updated_at', '2026-05-01T00:00:00.000Z')).data).toMatchObject({ unit_size: 10 })
    expect((await fake.from('user_settings').update({ unit_size: 25 }).eq('user_id', 'u1').lte('updated_at', '2026-06-01T00:00:00.000Z')).data).toMatchObject({ unit_size: 25 })
  })

  it('keeps deposits and withdrawals in their own table, and deletes only the one asked for', async () => {
    const fake = install('demo:', true)
    migrate('demo:')
    await fake.from('bankroll_moves').insert({ id: 'm', amount: 100 })
    await fake.from('bankroll_moves').insert({ id: 'n', amount: -40 })
    expect((await fake.from('bankroll_moves').insert({ id: 'm', amount: 1 })).error?.code).toBe('23505')
    expect((await fake.from('entries').select()).data).toEqual([])
    expect((await fake.from('bankroll_moves').delete().eq('id', 'm')).count).toBe(1)
    expect((await fake.from('bankroll_moves').select()).data).toMatchObject([{ id: 'n', amount: -40 }])
  })

  it('deletes only the bet asked for', async () => {
    const fake = install('demo:', true)
    migrate('demo:')
    localStorage.setItem('demo:rows', JSON.stringify([{ id: 'a' }, { id: 'b' }]))
    expect((await fake.from('entries').delete().eq('id', 'a')).count).toBe(1)
    expect((await fake.from('entries').select()).data).toEqual([{ id: 'b' }])
  })

  it('answers page by page with a count, so a long history reads in full (data/readAll.ts)', async () => {
    const fake = install('demo:', true)
    migrate('demo:')
    const n = PAGE_SIZE * 2 + 500
    localStorage.setItem('demo:rows', JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `r${i}` }))))
    const page = await fake.from('entries').select('*', { count: 'exact' }).range(0, 9)
    expect(page.data).toHaveLength(10)
    expect(page.count).toBe(n)
    const all = await readAll<{ id: string }>((from, to) => fake.from('entries').select('*', { count: 'exact' }).order('id').range(from, to))
    expect(all).toHaveLength(n)
    expect(new Set(all.map((r) => r.id)).size).toBe(n)
  })

  it('says so for a request it does not model', async () => {
    const fake = install('demo:', true)
    migrate('demo:')
    expect((await fake.from('user_settings').delete()).error?.code).toBe('FAKE')
    expect((await fake.from('bankroll_moves').upsert([])).error?.code).toBe('FAKE')
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
  const failedFetch = { data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 }

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

// What the e2e suite uses to play a server that misbehaves the way real ones do.
describe('fake Supabase: a server that misbehaves on purpose', () => {
  it('answers no more than max-rows rows a read, whatever page was asked for', async () => {
    const fake = install('e2e:', false)
    migrate('e2e:')
    localStorage.setItem('e2e:rows', JSON.stringify(Array.from({ length: 700 }, (_, i) => ({ id: `r${i}` }))))
    localStorage.setItem('e2e:max-rows', '300')
    const first = await fake.from('entries').select('*', { count: 'exact' }).range(0, PAGE_SIZE - 1)
    expect((first.data as unknown[]).length).toBe(300)
    expect(first.count).toBe(700)
    // As the app reads it: page by page from what came, all 700.
    expect(await readAll((from, to) => fake.from('entries').select('*', { count: 'exact' }).range(from, to))).toHaveLength(700)
  })

  it('refuses the next writes with the status asked for, changing nothing', async () => {
    const fake = install('e2e:', false)
    migrate('e2e:')
    localStorage.setItem('e2e:fail', JSON.stringify({ status: 503, message: 'Service Unavailable', times: 2 }))
    for (let i = 0; i < 2; i++) expect(await fake.from('entries').insert({ id: 'a' })).toMatchObject({ error: { message: 'Service Unavailable' }, status: 503 })
    expect(await fake.from('entries').insert({ id: 'a' })).toMatchObject({ error: null, status: 201 })
    expect(JSON.parse(localStorage.getItem('e2e:rows') ?? '[]')).toHaveLength(1)
  })

  it('drops the connection for writes after the ones it was told to let through', async () => {
    const fake = install('e2e:', false)
    migrate('e2e:')
    localStorage.setItem('e2e:writes-left', '1')
    expect(await fake.from('entries').insert({ id: 'a' })).toMatchObject({ error: null })
    expect(await fake.from('entries').insert({ id: 'b' })).toMatchObject({ error: { message: 'TypeError: Failed to fetch' }, status: 0 })
    expect(JSON.parse(localStorage.getItem('e2e:rows') ?? '[]')).toHaveLength(1)
  })

  it('fails the next reads of the table it was told to, with the status asked for', async () => {
    const fake = install('e2e:', false)
    migrate('e2e:')
    localStorage.setItem('e2e:fail-reads', JSON.stringify({ table: 'entries', status: 503, message: 'Service Unavailable', times: 1 }))
    expect(await fake.from('bankroll_moves').select('*')).toMatchObject({ error: null })
    expect(await fake.from('entries').select('*')).toMatchObject({ error: { message: 'Service Unavailable' }, status: 503 })
    expect(await fake.from('entries').select('*')).toMatchObject({ error: null, status: 200 })
  })

  it('holds every write on the wire while told to, and answers it once let go; reads go through', async () => {
    const fake = install('e2e:', false)
    migrate('e2e:')
    localStorage.setItem('e2e:hold', '1')
    let answered = false
    const write = Promise.resolve(fake.from('entries').insert({ id: 'a' })).then((r) => ((answered = true), r))
    expect(await fake.from('entries').select('*')).toMatchObject({ error: null, data: [] })
    await new Promise((r) => setTimeout(r, 60))
    expect(answered).toBe(false)
    expect(localStorage.getItem('e2e:writes-started')).toBe('1')
    localStorage.removeItem('e2e:hold')
    expect(await write).toMatchObject({ error: null, status: 201 })
  })

  it('hands over a read of the table it was told to, answered as the rows were then, only once let go', async () => {
    const fake = install('e2e:', false)
    migrate('e2e:')
    localStorage.setItem('e2e:hold-reads', 'entries')
    let answered = false
    const read = Promise.resolve(fake.from('entries').select('*')).then((r) => ((answered = true), r))
    // Other tables are not held.
    expect(await fake.from('bankroll_moves').select('*')).toMatchObject({ error: null })
    await new Promise((r) => setTimeout(r, 60))
    expect(answered).toBe(false)
    expect(localStorage.getItem('e2e:reads-held')).toBe('1')
    // A write lands while the read is held: the read was answered before it.
    expect(await fake.from('entries').insert({ id: 'a' })).toMatchObject({ error: null, status: 201 })
    localStorage.removeItem('e2e:hold-reads')
    expect(await read).toMatchObject({ error: null, data: [] })
  })

  it('leaves a row that is there as it is on an upsert that ignores duplicates', async () => {
    const fake = install('e2e:', false)
    migrate('e2e:')
    localStorage.setItem('e2e:rows', JSON.stringify([{ id: 'a', note: 'edited elsewhere', updated_at: 'T9' }]))
    const out = await fake.from('entries').upsert([{ id: 'a', note: 'import', updated_at: 'T1' }, { id: 'b', note: 'import', updated_at: 'T1' }], { ignoreDuplicates: true })
    expect(out.count).toBe(1)
    const rows = JSON.parse(localStorage.getItem('e2e:rows') ?? '[]') as { id: string; note: string }[]
    expect(rows.find((r) => r.id === 'a')?.note).toBe('edited elsewhere')
    expect(rows.find((r) => r.id === 'b')?.note).toBe('import')
  })

  it('ends the session when told to, saying SIGNED_OUT', async () => {
    const fake = install('e2e:', false)
    const events: string[] = []
    fake.auth.onAuthStateChange((event) => void events.push(event))
    fake.__endSession()
    expect(events).toEqual(['SIGNED_OUT'])
    expect((await fake.auth.getSession()).data.session).toBeNull()
  })
})

describe('fake Supabase: the expenses, cards and budgets of migration 008', () => {
  const TABLES = [
    ['expenses', 'expenses'],
    ['expense_cards', 'expense-cards'],
    ['expense_budgets', 'expense-budgets']
  ] as const
  const at = '2026-11-01T10:00:00.000Z'
  const later = '2026-11-01T11:00:00.000Z'
  const all = (prefix: string, name: string) => JSON.parse(localStorage.getItem(prefix + name) ?? '[]') as Record<string, unknown>[]

  it('without 008, every request for them is refused as a missing table, reads, writes and deletes', async () => {
    const fake = install('e2e:', false)
    migrate('e2e:')
    localStorage.setItem('e2e:migrated-007', '1')
    for (const [table] of TABLES) {
      const read = await fake.from(table).select('*', { count: 'exact' }).range(0, 999)
      expect(read.error, table).toEqual({ message: `Could not find the table 'public.${table}' in the schema cache`, code: 'PGRST205' })
      expect(read.status).toBe(404)
      expect((await fake.from(table).insert({ id: 'x', updated_at: at }).select()).error?.code).toBe('PGRST205')
      expect((await fake.from(table).update({ note: 'x' }).eq('id', 'x').lte('updated_at', at)).error?.code).toBe('PGRST205')
      expect((await fake.from(table).delete().eq('id', 'x')).error?.code).toBe('PGRST205')
    }
    expect(localStorage.getItem('e2e:expenses')).toBeNull()
  })

  it('a table it does not know is refused, and never answered as the bets', async () => {
    const fake = install('e2e:', false)
    migrate('e2e:')
    localStorage.setItem('e2e:rows', JSON.stringify([{ id: 'a' }]))
    expect((await fake.from('nonsense').select()).error).toEqual({ message: "Could not find the table 'public.nonsense' in the schema cache", code: 'PGRST205' })
    expect((await fake.from('nonsense').insert({ id: 'b' })).error?.code).toBe('PGRST205')
    expect(all('e2e:', 'rows')).toEqual([{ id: 'a' }])
  })

  it('with 008, each is its own table: adds (keeping a given created_at), refuses a duplicate id, edits under the conflict rule, deletes', async () => {
    const fake = install('e2e:', false)
    migrate('e2e:')
    localStorage.setItem('e2e:migrated-008', '1')
    for (const [table, name] of TABLES) {
      const added = await fake.from(table).insert({ id: 'a', note: 'one', created_at: '2026-10-31T09:00:00.000Z', updated_at: at }).select()
      expect(added.error, table).toBeNull()
      expect(added.data).toMatchObject({ id: 'a', created_at: '2026-10-31T09:00:00.000Z', updated_at: at })
      expect((await fake.from(table).insert({ id: 'a', updated_at: at })).error?.message).toBe(`duplicate key value violates unique constraint "${table}_pkey"`)
      expect((await fake.from(table).update({ note: 'old' }).eq('id', 'a').lte('updated_at', '2026-10-01T00:00:00.000Z')).data).toBeNull()
      expect((await fake.from(table).update({ note: 'new', updated_at: later }).eq('id', 'a').lte('updated_at', later)).data).toMatchObject({ note: 'new' })
      expect(all('e2e:', name)).toHaveLength(1)
      expect((await fake.from(table).delete().eq('id', 'a')).count).toBe(1)
      expect(all('e2e:', name)).toEqual([])
    }
    // Nothing of theirs landed in the bets or the moves.
    expect(localStorage.getItem('e2e:rows')).toBeNull()
    expect(localStorage.getItem('e2e:moves')).toBeNull()
  })

  it('keeps one budget per scope and target, and finds it by them', async () => {
    const fake = install('e2e:', false)
    migrate('e2e:')
    localStorage.setItem('e2e:migrated-008', '1')
    await fake.from('expense_budgets').insert({ id: 'b1', scope: 'total', target: '', monthly_limit: 100, updated_at: at })
    const again = await fake.from('expense_budgets').insert({ id: 'b2', scope: 'total', target: '', monthly_limit: 200, updated_at: later })
    expect(again.error).toEqual({ message: 'duplicate key value violates unique constraint "expense_budgets_one_per_target"', code: '23505' })
    expect((await fake.from('expense_budgets').select('*').eq('scope', 'total').eq('target', '').maybeSingle()).data).toMatchObject({ id: 'b1' })
    expect((await fake.from('expense_budgets').select('*').eq('scope', 'category').eq('target', 'coffee').maybeSingle()).data).toBeNull()
  })

  it('remembers their deleted rows only with 008 (007 alone covers the bets and moves)', async () => {
    const fake = install('e2e:', false)
    migrate('e2e:')
    localStorage.setItem('e2e:migrated-007', '1')
    localStorage.setItem('e2e:migrated-008', '1')
    await fake.from('expenses').insert({ id: 'e', updated_at: at })
    await fake.from('expenses').delete().eq('id', 'e')
    expect(JSON.parse(localStorage.getItem('e2e:tombstones') ?? '{}')).toEqual({ 'expenses:e': at })
    expect((await fake.from('expenses').insert({ id: 'e', updated_at: at }).select()).data).toEqual([])
    expect((await fake.from('expenses').insert({ id: 'e', updated_at: later }).select()).data).toMatchObject({ id: 'e' })

    // 007 without 008 can't be (008 needs 007), but 008's stones never hang on 007's flag.
    localStorage.clear()
    const other = install('e2e:', false)
    migrate('e2e:')
    localStorage.setItem('e2e:migrated-008', '1')
    await other.from('expense_cards').insert({ id: 'c', name: 'Visa', updated_at: at })
    await other.from('expense_cards').delete().eq('id', 'c')
    expect(JSON.parse(localStorage.getItem('e2e:tombstones') ?? '{}')).toEqual({ 'expense-cards:c': at })
  })

  it('has the currency column of the settings only with 008', async () => {
    const fake = install('e2e:', false)
    migrate('e2e:')
    const noColumn = { message: "Could not find the 'expense_currency' column of 'user_settings' in the schema cache", code: 'PGRST204' }
    // Without 008: a write that names it is refused (the whole write), a row has no such key.
    expect((await fake.from('user_settings').insert({ user_id: 'u1', expense_currency: 'EUR', updated_at: at })).error).toEqual(noColumn)
    const first = await fake.from('user_settings').insert({ user_id: 'u1', unit_size: 10, updated_at: at })
    expect(first.data).not.toHaveProperty('expense_currency')
    const refused = await fake.from('user_settings').update({ expense_currency: 'EUR', updated_at: later }).eq('user_id', 'u1').lte('updated_at', later)
    expect(refused).toMatchObject({ error: noColumn, status: 400 })
    expect((await fake.from('user_settings').select().maybeSingle()).data).not.toHaveProperty('expense_currency')
    // With 008: dollars by default, then whatever is set.
    localStorage.setItem('e2e:migrated-008', '1')
    expect((await fake.from('user_settings').select().maybeSingle()).data).toMatchObject({ unit_size: 10, expense_currency: 'USD' })
    expect((await fake.from('user_settings').update({ expense_currency: 'EUR', updated_at: later }).eq('user_id', 'u1').lte('updated_at', later)).data).toMatchObject({ expense_currency: 'EUR' })
    expect((await fake.from('user_settings').select().maybeSingle()).data).toMatchObject({ expense_currency: 'EUR' })
  })

  it('gives a first settings row the dollars default only with 008', async () => {
    const fake = install('demo:', true)
    migrate('demo:')
    localStorage.setItem('demo:migrated-008', '1')
    expect((await fake.from('user_settings').insert({ user_id: 'u1', updated_at: at })).data).toMatchObject({ expense_currency: 'USD' })
  })

  it('loses the answer of a write to them as it does for the rest: the write lands', async () => {
    const fake = install('e2e:', false)
    migrate('e2e:')
    localStorage.setItem('e2e:migrated-008', '1')
    localStorage.setItem('e2e:lose-answers', '1')
    expect((await fake.from('expenses').insert({ id: 'e', updated_at: at })).error?.message).toBe('TypeError: Failed to fetch')
    expect(all('e2e:', 'expenses')).toMatchObject([{ id: 'e' }])
    expect(localStorage.getItem('e2e:rows')).toBeNull()
  })
})

// The AI reading (functions.invoke): never the network, and checked as the Edge Function checks a request.
describe('fake Supabase: the AI reading of receipts', () => {
  const CONTRACT: ExtractionContract = { parseExtractRequest: extraction.parseExtractRequest, failBody: extraction.failBody, EXTRACT_STATUS: extraction.EXTRACT_STATUS }
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(68).fill(7)]).toString('base64')
  const body = (over: Record<string, unknown> = {}) => ({
    v: 1,
    image: { mediaType: 'image/jpeg', data: JPEG },
    today: '2026-11-01',
    timeZone: 'Europe/Madrid',
    lang: 'es',
    currency: 'EUR',
    cards: [{ name: 'Visa Oro', last4: '1234', kind: 'credit' }],
    ...over
  })
  const contextOf = (out: Invoked) => out.error?.context as Response
  const counter = (name: string) => Number(localStorage.getItem(name) || 0)

  beforeEach(() => {
    ;(globalThis as unknown as { __expenseExtraction?: ExtractionContract }).__expenseExtraction = CONTRACT
  })
  afterEach(() => {
    delete (globalThis as unknown as { __expenseExtraction?: ExtractionContract }).__expenseExtraction
  })

  it('the demo answers a sample: today’s coffee on the first card sent, yesterday’s groceries (even across a month)', async () => {
    const out = await install('demo:', true).functions.invoke('extract-expenses', { body: body() })
    expect(out).toEqual({
      data: {
        ok: true,
        kind: 'wallet',
        currency: 'EUR',
        warnings: [],
        sample: true,
        expenses: [
          { date: '2026-11-01', amount: 4.5, merchant: 'Café Central', category: 'coffee', cardLast4: '1234', cardHint: 'Visa Oro', note: '', pending: false, confidence: 'high' },
          { date: '2026-10-31', amount: 23.18, merchant: 'Supermercado La Plaza', category: 'groceries', cardLast4: null, cardHint: null, note: '', pending: false, confidence: 'medium' }
        ]
      },
      error: null
    })
    // The app reads it back as a valid answer.
    expect(extraction.normalizeExtraction(out.data, { today: '2026-11-01', lang: 'es', allowSample: true })?.expenses).toHaveLength(2)
  })

  it('the e2e server: no sample flag, and no card when none was sent', async () => {
    const out = await install('e2e:', false).functions.invoke('extract-expenses', { body: body({ cards: [] }) })
    expect(out.data).not.toHaveProperty('sample')
    expect((out.data as { expenses: { cardLast4: unknown; cardHint: unknown }[] }).expenses[0]).toMatchObject({ cardLast4: null, cardHint: null })
  })

  it('ai-rows: an array is the rows, an object is merged into the answer', async () => {
    const fake = install('e2e:', false)
    localStorage.setItem('e2e:ai-rows', JSON.stringify([{ amount: -12 }]))
    expect((await fake.functions.invoke('extract-expenses', { body: body() })).data).toMatchObject({ ok: true, kind: 'wallet', expenses: [{ amount: -12 }] })
    localStorage.setItem('e2e:ai-rows', JSON.stringify({ kind: 'receipt', currency: 'MXN', warnings: ['cut off'] }))
    expect((await fake.functions.invoke('extract-expenses', { body: body() })).data).toMatchObject({ kind: 'receipt', currency: 'MXN', warnings: ['cut off'], expenses: [{}, {}] })
  })

  it.each([
    ['limit_reached', 402],
    ['refused', 422],
    ['not_allowed', 403],
    ['not_configured', 503],
    ['too_long', 422]
  ])('ai-fail %s: that HTTP status, with a body the app can read', async (code, status) => {
    const fake = install('e2e:', false)
    localStorage.setItem('e2e:ai-fail', code)
    const out = await fake.functions.invoke('extract-expenses', { body: body() })
    expect(out.error?.name).toBe('FunctionsHttpError')
    expect(contextOf(out).status).toBe(status)
    expect(await contextOf(out).json()).toMatchObject({ ok: false, code })
  })

  it('ai-fail rate_limited carries a wait; not_deployed, relay and network are the platform’s', async () => {
    const fake = install('e2e:', false)
    localStorage.setItem('e2e:ai-fail', 'rate_limited')
    expect(await contextOf(await fake.functions.invoke('extract-expenses', { body: body() })).json()).toMatchObject({ code: 'rate_limited', retryAfter: 2 })
    localStorage.setItem('e2e:ai-fail', 'not_deployed')
    const missing = await fake.functions.invoke('extract-expenses', { body: body() })
    expect([missing.error?.name, contextOf(missing).status]).toEqual(['FunctionsHttpError', 404])
    expect(await contextOf(missing).json()).toEqual({ code: 'NOT_FOUND', message: 'Requested function was not found' })
    localStorage.setItem('e2e:ai-fail', 'relay')
    expect((await fake.functions.invoke('extract-expenses', { body: body() })).error?.name).toBe('FunctionsRelayError')
    localStorage.setItem('e2e:ai-fail', 'network')
    const net = await fake.functions.invoke('extract-expenses', { body: body() })
    expect([net.error?.name, (net.error?.context as Error).name]).toEqual(['FunctionsFetchError', 'TypeError'])
  })

  it.each<[string, Record<string, unknown>, number, string]>([
    ['a data: prefix', { image: { mediaType: 'image/jpeg', data: `data:image/jpeg;base64,${JPEG}` } }, 400, 'bad_request'],
    ['no today', { today: 'yesterday' }, 400, 'bad_request'],
    ['PNG said to be JPEG', { image: { mediaType: 'image/jpeg', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, ...new Array(68).fill(7)]).toString('base64') } }, 415, 'unsupported'],
    ['a GIF', { image: { mediaType: 'image/gif', data: JPEG } }, 415, 'unsupported'],
    ['too large', { image: { mediaType: 'image/jpeg', data: JPEG + 'A'.repeat(1_600_000) } }, 413, 'too_large']
  ])('refuses a request the function would refuse: %s', async (_name, over, status, code) => {
    const fake = install('e2e:', false)
    const out = await fake.functions.invoke('extract-expenses', { body: body(over) })
    expect(contextOf(out).status).toBe(status)
    expect(await contextOf(out).json()).toMatchObject({ ok: false, code })
    expect(counter('e2e:ai-answered')).toBe(0)
  })

  it('down → a failed fetch; signed out → 401; another function → 404', async () => {
    const fake = install('e2e:', false)
    localStorage.setItem('e2e:down', '1')
    expect((await fake.functions.invoke('extract-expenses', { body: body() })).error?.name).toBe('FunctionsFetchError')
    localStorage.removeItem('e2e:down')
    expect(contextOf(await fake.functions.invoke('other', { body: body() })).status).toBe(404)
    fake.__endSession()
    const out = await fake.functions.invoke('extract-expenses', { body: body() })
    expect(contextOf(out).status).toBe(401)
    expect(await contextOf(out).json()).toMatchObject({ code: 'unauthorized' })
    expect(counter('e2e:ai-calls')).toBe(0)
  })

  it('a page without the contract fails loudly instead of answering unchecked', async () => {
    delete (globalThis as unknown as { __expenseExtraction?: ExtractionContract }).__expenseExtraction
    const out = await install('e2e:', false).functions.invoke('extract-expenses', { body: body() })
    expect(contextOf(out).status).toBe(500)
  })

  it('ai-hold: the answer waits until released; an abort meanwhile is a failed fetch (AbortError)', async () => {
    const fake = install('e2e:', false)
    localStorage.setItem('e2e:ai-hold', '1')
    let settled = false
    const held = fake.functions.invoke('extract-expenses', { body: body() }).then((o) => ((settled = true), o))
    await new Promise((r) => setTimeout(r, 60))
    expect([settled, counter('e2e:ai-calls')]).toEqual([false, 0])
    localStorage.removeItem('e2e:ai-hold')
    expect((await held).data).toMatchObject({ ok: true })
    expect(counter('e2e:ai-calls')).toBe(1)

    localStorage.setItem('e2e:ai-hold', '1')
    const ctl = new AbortController()
    const cancelled = fake.functions.invoke('extract-expenses', { body: body(), signal: ctl.signal })
    await new Promise((r) => setTimeout(r, 30))
    ctl.abort()
    const out = await cancelled
    expect([out.error?.name, (out.error?.context as DOMException).name]).toEqual(['FunctionsFetchError', 'AbortError'])
    expect([counter('e2e:ai-calls'), counter('e2e:ai-answered')]).toEqual([1, 1])
  })

  it('ai-ignore-abort: a held call answers after the abort, once released (the late answer the app must drop)', async () => {
    const fake = install('e2e:', false)
    localStorage.setItem('e2e:ai-hold', '1')
    localStorage.setItem('e2e:ai-ignore-abort', '1')
    const ctl = new AbortController()
    const late = fake.functions.invoke('extract-expenses', { body: body(), signal: ctl.signal })
    ctl.abort()
    await new Promise((r) => setTimeout(r, 60))
    expect(counter('e2e:ai-answered')).toBe(0)
    localStorage.removeItem('e2e:ai-hold')
    expect((await late).data).toMatchObject({ ok: true })
    expect(counter('e2e:ai-answered')).toBe(1)
  })

  it('counts calls, notes what was sent but never the image, and is no write', async () => {
    const fake = install('e2e:', false)
    localStorage.setItem('e2e:fail', JSON.stringify({ status: 503, message: 'busy', times: 5 }))
    localStorage.setItem('e2e:writes-left', '0')
    localStorage.setItem('e2e:hold', '1')
    localStorage.setItem('e2e:lose-answers', '3')
    await fake.functions.invoke('extract-expenses', { body: body() })
    await fake.functions.invoke('extract-expenses', { body: body() })
    expect([counter('e2e:ai-calls'), counter('e2e:ai-answered')]).toEqual([2, 2])
    const last = JSON.parse(localStorage.getItem('e2e:ai-last') ?? 'null')
    expect(last).toEqual({ today: '2026-11-01', lang: 'es', currency: 'EUR', cards: 1, mediaType: 'image/jpeg', chars: JPEG.length, head: JPEG.slice(0, 32) })
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) as string
      expect(localStorage.getItem(k), k).not.toContain(JPEG)
    }
    expect([localStorage.getItem('e2e:writes'), localStorage.getItem('e2e:writes-started')]).toEqual([null, null])
    expect(JSON.parse(localStorage.getItem('e2e:fail') ?? 'null').times).toBe(5)
    expect(localStorage.getItem('e2e:lose-answers')).toBe('3')
  })
})
