import { useCallback, useEffect, useState } from 'react'

export type Theme = 'dark' | 'light'

const KEY = 'bettracker:theme'

function systemTheme(): Theme {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function stored(): Theme | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw === 'dark' || raw === 'light' ? raw : null
  } catch {
    return null
  }
}

/** Applied before React mounts (see index.html) and again on every change. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  const bg = theme === 'light' ? '#f6f7f9' : '#0a0f14'
  root.dataset.theme = theme
  root.style.background = bg
  // Keeps the mobile browser/PWA chrome in step with the app.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg)
}

/**
 * Colour scheme, remembered per device.
 *
 * With no stored choice the app follows the OS and keeps following it if the
 * OS flips; picking a theme explicitly pins it until the user picks again.
 */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() => stored() ?? systemTheme())
  const [pinned, setPinned] = useState<boolean>(() => stored() !== null)

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  useEffect(() => {
    if (pinned) return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = (e: MediaQueryListEvent): void => setTheme(e.matches ? 'light' : 'dark')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [pinned])

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark'
      try {
        localStorage.setItem(KEY, next)
      } catch {
        // Storage unavailable — the choice just won't survive a reload.
      }
      return next
    })
    setPinned(true)
  }, [])

  return { theme, toggle }
}
