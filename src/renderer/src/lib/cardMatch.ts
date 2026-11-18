import type { ExpenseCard } from '../../../shared/types'

/**
 * Which of the user's cards an AI reading names. The model only ever hears
 * the cards' names, last 4 digits and kinds (never their ids), and answers
 * with what the image shows: the digits printed on it and a card's name. This
 * maps that back to a card, on the device. Archived cards are never matched:
 * they are hidden from every card picker.
 */

export interface CardHint {
  last4: string | null
  name: string | null
}

export type CardMatch = { cardId: string; how: 'last4' | 'name' } | { cardId: null; how: 'none' }

/** lowercase, accents stripped, anything but letters and digits as a space, collapsed: "Visa Oro (BBVA)" → "visa oro bbva". */
export function normalizeCardName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** The card's name and the hint name each other: equal, one inside the other (the shorter ≥ 3 chars), or every word (≥ 2 chars) of the card's name in the hint. */
function namesMatch(cardName: string, hint: string): boolean {
  const c = normalizeCardName(cardName)
  if (c === '' || hint === '') return false
  if (c === hint) return true
  const [shorter, longer] = c.length <= hint.length ? [c, hint] : [hint, c]
  if (shorter.length >= 3 && longer.includes(shorter)) return true
  const words = c.split(' ').filter((w) => w.length >= 2)
  const hintWords = new Set(hint.split(' '))
  return words.length > 0 && words.every((w) => hintWords.has(w))
}

const none: CardMatch = { cardId: null, how: 'none' }

/**
 * (1) Exactly 4 digits: the one active card with those digits; several →
 * the one among them the name points to. (2) Otherwise the name: exactly one
 * active card whose name matches. (3) Else none: never a guess.
 */
export function matchCard(hint: CardHint, cards: readonly ExpenseCard[]): CardMatch {
  const active = cards.filter((c) => !c.archived)
  const name = hint.name === null ? '' : normalizeCardName(hint.name)
  const byName = (among: readonly ExpenseCard[]): ExpenseCard[] => (name === '' ? [] : among.filter((c) => namesMatch(c.name, name)))
  if (hint.last4 !== null && /^\d{4}$/.test(hint.last4)) {
    const same = active.filter((c) => c.last4 === hint.last4)
    if (same.length === 1) return { cardId: same[0].id, how: 'last4' }
    if (same.length > 1) {
      const narrowed = byName(same)
      return narrowed.length === 1 ? { cardId: narrowed[0].id, how: 'last4' } : none
    }
  }
  const named = byName(active)
  return named.length === 1 ? { cardId: named[0].id, how: 'name' } : none
}
