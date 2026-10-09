import { monthPrefix, type MonthKey } from './dates'

/**
 * The monthly loss limit is a warning, never a gate: the app shows a banner
 * when the month's net loss reaches 80% of the limit and a stronger one once
 * it passes it, and keeps logging bets either way.
 */
export type LossLevel = 'none' | 'near' | 'over'

export const NEAR_RATIO = 0.8

export interface LossState {
  level: LossLevel
  /** The month's net loss as a positive number (0 when the month is up). */
  loss: number
  limit: number | null
  /** loss / limit, 0 without a limit. */
  ratio: number
}

export function lossState(monthTotal: number, limit: number | null): LossState {
  const loss = Math.max(0, -monthTotal)
  if (limit === null || limit <= 0) return { level: 'none', loss, limit, ratio: 0 }
  const ratio = loss / limit
  const level: LossLevel = ratio >= 1 ? 'over' : ratio >= NEAR_RATIO ? 'near' : 'none'
  return { level, loss, limit, ratio }
}

/** A dismissal is per month and per level, so the banner returns next month and when the next line is crossed. */
export const dismissKey = (ym: MonthKey, level: LossLevel): string => `${monthPrefix(ym)}:${level}`

const KEY = 'bettracker:loss-dismissed'

export function loadLossDismissed(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function saveLossDismissed(key: string): void {
  try {
    localStorage.setItem(KEY, key)
  } catch {
    // Storage unavailable — the banner will simply show again after a reload.
  }
}
