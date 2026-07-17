import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type BetTrackerApi, type EntryInput } from '../shared/types'

const api: BetTrackerApi = {
  getEntries: () => ipcRenderer.invoke(IPC.getEntries),
  upsertEntry: (input: EntryInput) => ipcRenderer.invoke(IPC.upsertEntry, input),
  deleteEntry: (date: string) => ipcRenderer.invoke(IPC.deleteEntry, date),
  exportCsv: () => ipcRenderer.invoke(IPC.exportCsv)
}

contextBridge.exposeInMainWorld('api', api)
