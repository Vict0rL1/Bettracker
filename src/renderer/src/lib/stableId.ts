import type { BudgetScope } from '../../../shared/types'

/**
 * A UUID-formatted id derived from `text` (cyrb128, public domain; version
 * nibble 8, RFC 4122 variant). Same text, same id, on every device. Not a
 * secret and not collision-proof against an adversary: it only lets two
 * devices that mean the same row write the same row.
 */
export function stableUuid(text: string): string {
  let h1 = 1779033703
  let h2 = 3144134277
  let h3 = 1013904242
  let h4 = 2773480762
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  h1 ^= h2 ^ h3 ^ h4
  h2 ^= h1
  h3 ^= h1
  h4 ^= h1
  const hex = [h1, h2, h3, h4]
    .map((h) => (h >>> 0).toString(16).padStart(8, '0'))
    .join('')
    .split('')
  hex[12] = '8' // version 8 (custom)
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) // variant 10xx
  const s = hex.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

/**
 * The id of a user's budget for (scope, target): two devices setting the same
 * budget write the same row (migration 008's one-per-target key). The user id
 * is part of it because a primary key is global across users. Frozen: never
 * change it (a pinned test holds it), or budgets set before would no longer
 * meet the ones set after.
 */
export const budgetId = (userId: string, scope: BudgetScope, target: string): string =>
  stableUuid(`expense-budget|${userId.toLowerCase()}|${scope}|${scope === 'card' ? target.toLowerCase() : target}`)
