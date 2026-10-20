import { useSyncExternalStore } from 'react'

/** True while the media query matches; follows it as the window changes. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia?.(query)
      if (!list) return () => {}
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    () => Boolean(window.matchMedia?.(query).matches),
    () => false
  )
}

/** The phone layout's width, as the stylesheet's `max-width: 640px` blocks. */
export const NARROW = '(max-width: 640px)'
