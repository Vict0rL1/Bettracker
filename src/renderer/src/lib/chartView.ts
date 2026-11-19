import { shiftDays } from './range'

/**
 * What the balance chart draws: the P/L curve (results only, from 0) or the
 * bankroll (the starting bankroll plus deposits, withdrawals and results).
 * Remembered per device, like the range. The chart's arithmetic — which
 * dates get a label, where the axis starts and ends, the opening point — is
 * here too, so it can be tested without drawing anything.
 */
export type ChartView = 'pl' | 'bankroll'

export const CHART_VIEWS: readonly ChartView[] = ['pl', 'bankroll']

const KEY = 'bettracker:chart-view'

const isView = (v: unknown): v is ChartView => CHART_VIEWS.includes(v as ChartView)

/** The view chosen on this device, or P/L when none (or nonsense) is stored. */
export function loadChartView(): ChartView {
  try {
    const raw = localStorage.getItem(KEY)
    return isView(raw) ? raw : 'pl'
  } catch {
    return 'pl'
  }
}

export function saveChartView(view: ChartView): void {
  try {
    localStorage.setItem(KEY, view)
  } catch {
    // Storage unavailable — the choice just won't survive a reload.
  }
}

/** A point as drawn: values already in the unit shown (dollars, or units). */
export interface ChartPoint {
  date: string
  balance: number
  dayTotal: number
  /** Bankroll view only: that day's deposits less withdrawals, and the money put in so far. */
  moved?: number
  funded?: number
  /** The point before the first day shown: the balance carried in (bankroll), or the $0 a P/L curve starts from. */
  opening?: true
}

/**
 * The P/L curve's opening point: $0 the day before the first scored day, as
 * the bankroll series opens the day before its first point (lib/bankroll.ts).
 * So one settled day already draws a line, from 0 to its result, instead of
 * a lone dot and an empty state asking for a second day. Nothing scored:
 * nothing, so the chart can say so.
 */
export function withOpening<T extends { date: string; balance: number; dayTotal: number }>(points: readonly T[]): (T | ChartPoint)[] {
  if (points.length === 0) return []
  const opening: ChartPoint = { date: shiftDays(points[0].date, -1), balance: 0, dayTotal: 0, opening: true }
  return [opening, ...points]
}

/**
 * Which dates get an x-axis label: up to `count` of them, spread evenly from
 * the first point to the last (both always labelled), never the same date
 * twice. Recharts spaces the rest.
 */
export function xTicks(data: readonly { date: string }[], count = 5): string[] {
  if (data.length === 0) return []
  const n = Math.min(count, data.length)
  if (n === 1) return [data[0].date]
  const idx = new Set<number>()
  for (let i = 0; i < n; i++) idx.add(Math.round((i * (data.length - 1)) / (n - 1)))
  return [...idx].map((i) => data[i].date)
}

/**
 * Round bounds and about four ticks for a range of values: steps of 1, 2,
 * 2.5 or 5 times a power of ten, so the axis reads $1k, $1.2k, $1.4k rather
 * than wherever the data happens to end. `resolution` is the finest step the
 * labels can tell apart (the k labels keep one decimal, so 100 from 1,000
 * up): the step is always a multiple of it, so no two ticks read the same.
 */
export function niceScale(min: number, max: number, resolution = 0): { lo: number; hi: number; ticks: number[] } {
  const span = max - min || Math.abs(max) || 1
  const raw = span / 4
  const fits = (c: number): boolean => resolution === 0 || Math.abs(c / resolution - Math.round(c / resolution)) < 1e-9
  let step = 0
  for (let mag = 10 ** Math.floor(Math.log10(raw)); step === 0; mag *= 10) {
    for (const k of [1, 2, 2.5, 5]) {
      const c = k * mag
      if (c >= raw && c >= resolution && fits(c)) {
        step = c
        break
      }
    }
  }
  const lo = Math.floor(min / step) * step
  const top = Math.ceil(max / step) * step
  const hi = top === lo ? lo + step : top
  const ticks: number[] = []
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  return { lo, hi, ticks }
}

/**
 * The bankroll axis: niceScale at the resolution its labels have — whole
 * dollars (or hundredths of a unit) below 1,000, tenths of a thousand from
 * there up, judged on the ticks themselves, which may reach past the data.
 */
export function bankrollAxis(min: number, max: number, units: boolean): { lo: number; hi: number; ticks: number[] } {
  const fine = units ? 0.01 : 1
  const scale = niceScale(min, max, Math.max(Math.abs(min), Math.abs(max)) >= 1000 ? 100 : fine)
  return Math.max(Math.abs(scale.lo), Math.abs(scale.hi)) >= 1000 ? niceScale(min, max, 100) : scale
}

export interface YAxis {
  domain: [number, number]
  ticks: number[]
  /** Whether to draw the zero line: always for P/L, for a bankroll only when it crosses zero. */
  zero: boolean
}

/**
 * The y axis of either view, on the same round ticks (bankrollAxis). P/L
 * always includes zero, the line it is measured from; a bankroll is fitted
 * to its own range (the balance and the money put in) and shows zero only
 * when it gets there. A flat series — every point 0, or one point — still
 * gets a domain with room in it, never [0, 0], which would draw nothing.
 */
export function yAxisFor(mode: ChartView, data: readonly ChartPoint[], units: boolean): YAxis {
  if (data.length === 0) return { domain: [0, 1], ticks: [0, 1], zero: true }
  const values = mode === 'bankroll' ? data.flatMap((p) => [p.balance, p.funded ?? p.balance]) : [0, ...data.map((p) => p.balance)]
  const { lo, hi, ticks } = bankrollAxis(Math.min(...values), Math.max(...values), units)
  return { domain: [lo, hi], ticks, zero: mode === 'pl' || (lo <= 0 && hi >= 0) }
}
