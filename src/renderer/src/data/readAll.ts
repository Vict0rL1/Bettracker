import { describeError } from './errors'

/**
 * PostgREST answers at most `max-rows` rows a request: 1,000 on a hosted
 * Supabase project unless the owner changed it, and it cuts the rest
 * silently. A heavy user's history (or bankroll) built from one request
 * would quietly miss its newest rows, so every full read goes page by page.
 */
export const PAGE_SIZE = 1000

interface Page {
  data: unknown
  error: { message: string; code?: string } | null
  count?: number | null
  status?: number
}

/**
 * Read every row: ask for one page at a time (`page(from, to)` must be a
 * query ordered on something unique, so pages neither skip nor repeat a row).
 * A project can set `max-rows` below PAGE_SIZE, and then a page comes back
 * shorter than asked without being the last: so the next page starts after
 * the rows that came, and the read goes on until the total the server counted
 * is in, or, when it gave no count, until a page comes back empty.
 */
export async function readAll<R>(page: (from: number, to: number) => PromiseLike<Page>): Promise<R[]> {
  const rows: R[] = []
  for (;;) {
    const { data, error, count, status } = await page(rows.length, rows.length + PAGE_SIZE - 1)
    if (error) throw describeError(error, status)
    const got = (data ?? []) as R[]
    rows.push(...got)
    if (got.length === 0 || (typeof count === 'number' && rows.length >= count)) return rows
  }
}
