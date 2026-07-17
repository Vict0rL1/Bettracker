export interface BetEntry {
  id: number
  /** Local calendar date, YYYY-MM-DD. Unique — one entry per day. */
  date: string
  /** Net result in dollars: > 0 win, < 0 loss, 0 push (break-even). */
  amount: number
  note: string
  createdAt: string
  updatedAt: string
}

export interface EntryInput {
  date: string
  amount: number
  note?: string
}

export type ExportResult = { ok: true; path: string; count: number } | { ok: false; canceled: true }

/** Surface exposed to the renderer via the preload contextBridge. */
export interface BetTrackerApi {
  getEntries(): Promise<BetEntry[]>
  upsertEntry(input: EntryInput): Promise<BetEntry>
  deleteEntry(date: string): Promise<boolean>
  exportCsv(): Promise<ExportResult>
}

export const IPC = {
  getEntries: 'entries:get-all',
  upsertEntry: 'entries:upsert',
  deleteEntry: 'entries:delete',
  exportCsv: 'export:csv'
} as const
