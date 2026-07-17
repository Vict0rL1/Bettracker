import { BrowserWindow, app } from 'electron'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BetDb } from './db'
import { registerIpc } from './ipc'

// Test hooks: BETTRACKER_USERDATA points the app at a throwaway profile so
// smoke runs and UI checks never touch the real database.
const isSmoke = process.env.BETTRACKER_SMOKE === '1'
if (process.env.BETTRACKER_USERDATA) {
  app.setPath('userData', process.env.BETTRACKER_USERDATA)
} else if (isSmoke) {
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'bettracker-smoke-')))
}

let db: BetDb | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1000,
    minHeight: 680,
    show: false,
    backgroundColor: '#0a0f14',
    autoHideMenuBar: true,
    title: 'BetTracker',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

/** Headless CI check: poll until the renderer flags itself ready, then exit. */
function runSmoke(win: BrowserWindow): void {
  const deadline = setTimeout(() => {
    console.error('SMOKE_TIMEOUT')
    app.exit(1)
  }, 30_000)

  const poll = (): void => {
    win.webContents
      .executeJavaScript(`document.documentElement.dataset.ready === '1'`)
      .then((ready: unknown) => {
        if (ready === true) {
          clearTimeout(deadline)
          console.log('SMOKE_OK')
          app.exit(0)
        } else {
          setTimeout(poll, 250)
        }
      })
      .catch(() => setTimeout(poll, 250))
  }
  win.webContents.on('did-finish-load', poll)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void app.whenReady().then(() => {
    db = new BetDb(join(app.getPath('userData'), 'bettracker.db'))
    registerIpc(db)
    const win = createWindow()
    if (isSmoke) runSmoke(win)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => {
    db?.close()
    db = null
  })
}
