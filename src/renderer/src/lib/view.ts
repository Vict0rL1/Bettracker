/**
 * Which part of the app is open — the bets or the expenses — and how the
 * spending chart is drawn. Both remembered per device (not per user: they
 * survive a sign-out), like the range and the chart view. Never in the URL:
 * the hash belongs to Supabase's sign-in links.
 */

export type AppView = 'bets' | 'expenses'

export const APP_VIEWS: readonly AppView[] = ['bets', 'expenses']

const VIEW_KEY = 'bettracker:view'

/** The view this device last showed: the expenses only when that is what is stored, else the bets. */
export function loadView(): AppView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'expenses' ? 'expenses' : 'bets'
  } catch {
    return 'bets'
  }
}

export function saveView(v: AppView): void {
  try {
    localStorage.setItem(VIEW_KEY, v)
  } catch {
    // Storage unavailable — the app just opens on the bets next time.
  }
}

/** The spending chart: the running total of the month, or each day's spending. */
export type SpendChartView = 'cumulative' | 'daily'

const CHART_KEY = 'bettracker:spend-chart'

export function loadSpendChartView(): SpendChartView {
  try {
    return localStorage.getItem(CHART_KEY) === 'daily' ? 'daily' : 'cumulative'
  } catch {
    return 'cumulative'
  }
}

export function saveSpendChartView(v: SpendChartView): void {
  try {
    localStorage.setItem(CHART_KEY, v)
  } catch {
    // Storage unavailable — the choice just won't survive a reload.
  }
}
