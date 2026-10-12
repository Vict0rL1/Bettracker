import { useEffect, useRef, useState } from 'react'

const show = (value: number | null): string => (value === null ? '' : String(value))

export interface Box {
  /** What the box shows. */
  text: string
  /** The user typed: the box now holds an edit, not the saved value. */
  edit: (text: string) => void
  /** The text to commit, or null when the box holds no edit of the user's. */
  pending: () => string | null
  /** Show this value as the box's settled state and forget the edit. */
  settle: (value: number | null) => void
}

/**
 * A money box in a dialog that stays open while the value it shows can
 * change underneath it (a refresh, another device). It follows the saved
 * value until the user types, and only then has anything to commit: closing
 * a dialog commits its boxes, and an untouched box must never send back the
 * value it happened to show when the dialog opened.
 */
export function useBox(saved: number | null): Box {
  const [text, setText] = useState(() => show(saved))
  const edited = useRef(false)
  const latest = useRef(text)
  latest.current = text

  useEffect(() => {
    if (!edited.current) setText(show(saved))
  }, [saved])

  return {
    text,
    edit: (next) => {
      edited.current = true
      latest.current = next
      setText(next)
    },
    pending: () => (edited.current ? latest.current : null),
    settle: (value) => {
      edited.current = false
      latest.current = show(value)
      setText(show(value))
    }
  }
}
