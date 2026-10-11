/**
 * What the balance chart draws: the P/L curve (results only, from 0) or the
 * bankroll (the starting bankroll plus deposits, withdrawals and results).
 * Remembered per device, like the range.
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

/**
 * Round bounds and about four ticks for a range of values: steps of 1, 2,
 * 2.5 or 5 times a power of ten, so the axis reads $1k, $1.2k, $1.4k rather
 * than wherever the data happens to end.
 */
export function niceScale(min: number, max: number): { lo: number; hi: number; ticks: number[] } {
  const span = max - min || Math.abs(max) || 1
  const raw = span / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag
  const lo = Math.floor(min / step) * step
  const hi = Math.ceil(max / step) * step === lo ? lo + step : Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  return { lo, hi, ticks }
}
