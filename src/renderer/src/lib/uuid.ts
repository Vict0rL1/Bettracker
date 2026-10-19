/**
 * A new id for a bet, a deposit or a queued change: a version 4 UUID.
 * Browsers only offer `crypto.randomUUID` on https and localhost; the dev
 * server's Network URL (plain http on the LAN, to try the app on a phone)
 * has `crypto.getRandomValues` and no more, so the id is made from that.
 */
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
