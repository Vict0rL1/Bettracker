import { BrowserWindow, app, session, shell } from 'electron'
import { join } from 'node:path'

// The desktop app is a native window around the same React UI the phone runs.
// All data lives in Supabase, so the main process holds no database — it just
// hosts the renderer and lets it talk to the cloud.
//
// Security posture: the renderer is treated as untrusted web content. It runs
// sandboxed with no Node access and a preload that exposes a single flag; it
// can only ever display our own bundle; anything that would leave it (a link,
// a redirect, a popup) goes to the system browser instead; and it is granted
// none of the browser permissions it never asks for.
const isSmoke = process.env.BETTRACKER_SMOKE === '1'

/** The only places the window is allowed to navigate: our bundle, or the dev server. */
function isOurs(url: string): boolean {
  if (url.startsWith('file://')) return true
  const dev = process.env.ELECTRON_RENDERER_URL
  return Boolean(dev && url.startsWith(dev))
}

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
      sandbox: true,
      webviewTag: false,
      // Defaults, pinned so a future Electron can't loosen them silently.
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // Open external links (e.g. Supabase email confirmations) in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // A link without target=_blank, or a script setting location, would
  // otherwise turn this window into a browser for whatever it was pointed at.
  win.webContents.on('will-navigate', (event, url) => {
    if (isOurs(url)) return
    event.preventDefault()
    if (url.startsWith('https://')) void shell.openExternal(url)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

/**
 * The app never asks for a camera, location, notifications or anything else,
 * so no page it shows should be able to get them either — a compromised bundle
 * would otherwise inherit a desktop app's standing with the OS.
 */
function lockDownPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  // No <webview> is ever created; refuse one anyway.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
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
    lockDownPermissions()
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
