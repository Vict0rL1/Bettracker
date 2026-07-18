import { BrowserWindow, app, shell } from 'electron'
import { join } from 'node:path'

// The desktop app is a native window around the same React UI the phone runs.
// All data lives in Supabase, so the main process holds no database — it just
// hosts the renderer and lets it talk to the cloud.
const isSmoke = process.env.BETTRACKER_SMOKE === '1'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 600,
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

  // Open external links (e.g. Supabase email confirmations) in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

/** Headless CI check: load the app, confirm the renderer boots, then exit. */
function runSmoke(win: BrowserWindow): void {
  const deadline = setTimeout(() => {
    console.error('SMOKE_TIMEOUT')
    app.exit(1)
  }, 30_000)

  const poll = (): void => {
    win.webContents
      .executeJavaScript(`document.documentElement.dataset.ready === '1' || !!document.querySelector('.auth-card,.app,.setup-card')`)
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
    const win = createWindow()
    if (isSmoke) runSmoke(win)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
