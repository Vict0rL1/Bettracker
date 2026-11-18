import { useEffect, useRef, useState, type RefObject } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Shown on the page: not display:none, not inside something hidden. */
const shown = (el: Element | null): el is HTMLElement => el instanceof HTMLElement && el.isConnected && el.getClientRects().length > 0

/**
 * Where focus goes when an expense dialog closes: back to what opened it when
 * that is still on the page, else the visible Add expense button, else the
 * + button, else the open view's panel. Never <body>: the + button is
 * unmounted while a dialog is open, and the `t` key opens one from <body>, so
 * "what opened it" is often gone.
 */
function restoreFocus(opener: HTMLElement | null): void {
  if (opener && opener !== document.body && shown(opener)) {
    opener.focus({ preventScroll: true })
    return
  }
  const candidates = [document.querySelector('.add-expense-btn'), document.querySelector('.fab'), document.querySelector('[role="tabpanel"]')]
  const target = candidates.find((el) => shown(el)) ?? document.querySelector<HTMLElement>('[role="tabpanel"]')
  target?.focus({ preventScroll: true })
}

/**
 * What the expense sheet and Expense settings share as dialogs: Escape closes
 * (through `onClose`, which may ask first), Tab stays inside, and focus goes
 * back where it belongs on the way out (restoreFocus). A stage change can
 * unmount the focused control; the next Tab then starts again at the
 * dialog's first control instead of walking into the page behind an
 * aria-modal dialog.
 */
export function useDialog(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  // What had focus as the dialog first rendered, before any of its own effects move it.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null))

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeRef.current()
        return
      }
      const dialog = ref.current
      if (e.key !== 'Tab' || !dialog) return
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0 || el === document.activeElement)
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (!(active instanceof Node) || !dialog.contains(active) || active === dialog) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      restoreFocus(opener)
    }
    // Once per dialog.
  }, [ref, opener])
}
