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
