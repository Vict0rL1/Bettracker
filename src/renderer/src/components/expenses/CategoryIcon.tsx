import type { ReactNode } from 'react'
import type { ExpenseCategory } from '../../../../shared/types'

/**
 * One small glyph per expense category, drawn for this app on a 16px grid:
 * strokes only (1.5, round caps and joins), in the ink of the text around it,
 * never a money colour. They sit next to the category's name and say nothing
 * the name doesn't, so they are hidden from screen readers.
 */
const GLYPHS: Record<ExpenseCategory, ReactNode> = {
  // A cup with its handle, and steam.
  coffee: (
    <>
      <path d="M2.75 6.75h8.5v3.5a3 3 0 0 1-3 3h-2.5a3 3 0 0 1-3-3z" />
      <path d="M11.25 7.75H12a1.75 1.75 0 0 1 0 3.5h-.75M5.5 2.25v2M8.5 2.25v2" />
    </>
  ),
  // A fork and a knife.
  food: <path d="M3.75 2.25v3.5a2 2 0 0 0 4 0v-3.5M5.75 2.25v11.5M12.25 13.75V2.25c-1.6.9-2.5 2.7-2.5 5v2.5h2.5" />,
  // A supermarket cart.
  groceries: (
    <>
      <path d="M1.75 2.75H3.5l1.75 7.5h6.5l1.5-5.25H4.05" />
      <path d="M6 13.25h.01M11 13.25h.01" />
    </>
  ),
  // A car, seen from the front.
  transport: (
    <>
      <path d="M3.25 8.25 4.6 4.7a1.25 1.25 0 0 1 1.17-.8h4.46a1.25 1.25 0 0 1 1.17.8l1.35 3.55" />
      <path d="M2.75 8.25h10.5v3.5H2.75zM4.5 11.75v1.5M11.5 11.75v1.5M5.25 10h.01M10.75 10h.01" />
    </>
  ),
  // A shopping bag.
  shopping: <path d="M3.25 5.75h9.5l.75 7.5h-11zM5.75 7.75v-3a2.25 2.25 0 0 1 4.5 0v3" />,
  // A ticket.
  entertainment: (
    <>
      <path d="M2.25 4.75h11.5v2.5a1.25 1.25 0 0 0 0 2.5v2.5H2.25v-2.5a1.25 1.25 0 0 0 0-2.5z" />
      <path d="M9.75 6.75v.5M9.75 9.25v.5" />
    </>
  ),
  // The cross of a pharmacy.
  health: <path d="M6.25 2.25h3.5v4h4v3.5h-4v4h-3.5v-4h-4v-3.5h4z" />,
  // A house.
  home: <path d="M1.75 7.5 8 2.25l6.25 5.25M3.75 6.25v7.5h8.5v-7.5M6.75 13.75v-3.5h2.5v3.5" />,
  // Two arrows going round: it comes back every month.
  subscriptions: <path d="M2.75 7.5v-1a2 2 0 0 1 2-2h8M10.75 2.5l2 2-2 2M13.25 8.5v1a2 2 0 0 1-2 2h-8M5.25 13.5l-2-2 2-2" />,
  // A plane, seen from above.
  travel: <path d="M8 1.75c.7 0 1.25.6 1.25 1.4V6l4.5 2.75v1.5l-4.5-1.4v2.65l1.5 1.1v1.15L8 13.1l-2.75.65V12.6l1.5-1.1V8.85l-4.5 1.4v-1.5L6.75 6V3.15c0-.8.55-1.4 1.25-1.4z" />,
  // Three dots in a circle: the rest.
  other: (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M5.5 8h.01M8 8h.01M10.5 8h.01" />
    </>
  )
}

interface Props {
  category: ExpenseCategory
  /** Side of the box in px (the glyphs are drawn for 16). */
  size?: number
}

export default function CategoryIcon({ category, size = 16 }: Props) {
  return (
    <svg
      className="cat-icon"
      data-cat-icon={category}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS[category]}
    </svg>
  )
}
