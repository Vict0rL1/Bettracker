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
}

/**
 * Read every row: ask for one page at a time (`page(from, to)` must be a
 * query ordered on something unique, so pages neither skip nor repeat a row)
 * until the total the server counted is reached, or a page comes back short
 * when it gave no count.
 */
export async function readAll<R>(page: (from: number, to: number) => PromiseLike<Page>): Promise<R[]> {
  const rows: R[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error, count } = await page(from, from + PAGE_SIZE - 1)
    if (error) throw describeError(error)
    const got = (data ?? []) as R[]
    rows.push(...got)
    const done = got.length === 0 || (typeof count === 'number' ? rows.length >= count : got.length < PAGE_SIZE)
    if (done) return rows
  }
}
