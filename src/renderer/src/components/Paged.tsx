import { useState, type ReactNode } from 'react'
import { useLang } from '../lib/i18n'

/** A long list, shown `first` at a time, with the rest one "Show more" away. */
export default function Paged<T>({ items, first, step, render, className }: { items: readonly T[]; first: number; step: number; render: (item: T) => ReactNode; className: string }) {
  const { t } = useLang()
  const [shown, setShown] = useState(first)
  const visible = items.slice(0, shown)
  return (
    <>
      <ul className={className}>{visible.map(render)}</ul>
      {items.length > shown && (
        <p className="imp-more">
          <span className="hint">{t('imp.showing', { shown: visible.length, total: items.length })}</span>{' '}
          <button type="button" className="btn btn-ghost imp-show-more" onClick={() => setShown((n) => n + step)}>
            {t('imp.showMore', { n: Math.min(step, items.length - shown) })}
          </button>
        </p>
      )}
    </>
  )
}
