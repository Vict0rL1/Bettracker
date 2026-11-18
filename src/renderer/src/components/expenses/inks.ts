import type { ExpenseCard } from '../../../../shared/types'
import { NO_CARD, SERIES_INKS } from '../../lib/spend'

const byCreated = (a: ExpenseCard, b: ExpenseCard): number => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * A card's ink, as the chart draws it (lib/spend.ts spendChartData): its place
 * among all the cards, oldest first, so a card keeps its grey from month to
 * month. "No card" (and a card this device doesn't know) is the outlined swatch.
 */
export function inkOf(key: string, cards: readonly ExpenseCard[]): { ink: string; dashed: boolean } {
  if (key === NO_CARD) return { ink: 'var(--series-none)', dashed: true }
  const i = [...cards].sort(byCreated).findIndex((c) => c.id === key)
  return i < 0 ? { ink: 'var(--series-none)', dashed: true } : { ink: SERIES_INKS[i % SERIES_INKS.length], dashed: false }
}
