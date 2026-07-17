import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BetDb } from './db'
import { entriesToCsv } from './csv'
import { IPC, type EntryInput, type ExportResult } from '../shared/types'

function localStamp(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function registerIpc(db: BetDb): void {
  ipcMain.handle(IPC.getEntries, () => db.getAll())
  ipcMain.handle(IPC.upsertEntry, (_evt, input: EntryInput) => db.upsert(input))
  ipcMain.handle(IPC.deleteEntry, (_evt, date: string) => db.remove(date))

  ipcMain.handle(IPC.exportCsv, async (evt): Promise<ExportResult> => {
    const win = BrowserWindow.fromWebContents(evt.sender)
    const options = {
      title: 'Export BetTracker data',
      defaultPath: join(app.getPath('documents'), `bettracker-export-${localStamp()}.csv`),
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    const entries = db.getAll()
    await writeFile(result.filePath, entriesToCsv(entries), 'utf8')
    return { ok: true, path: result.filePath, count: entries.length }
  })
}
