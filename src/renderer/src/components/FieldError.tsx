import type { Problem } from '../lib/betForm'
import { useLang } from '../lib/i18n'

/**
 * A box's problem, in words, under it. The box points here with
 * aria-describedby, so moving focus to it reads the problem out; nothing is
 * announced while typing.
 */
export default function FieldError({ id, problem }: { id: string; problem: Problem | null }) {
  const { t } = useLang()
  if (!problem) return null
  return (
    <p id={id} className="field-error">
      {t(problem.key, problem.vars)}
    </p>
  )
}

/** The ids a box is described by: its problem's, when shown, and any note of its own. */
export const describedBy = (...ids: (string | false | null | undefined)[]): string | undefined => {
  const list = ids.filter(Boolean)
  return list.length > 0 ? list.join(' ') : undefined
}
