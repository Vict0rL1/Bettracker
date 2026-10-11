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
