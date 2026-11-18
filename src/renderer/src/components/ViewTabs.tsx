import { useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useLang } from '../lib/i18n'
import { APP_VIEWS, type AppView } from '../lib/view'

interface Props {
  view: AppView
  onChange: (v: AppView) => void
}

/**
 * Bets | Expenses, under the top bar. A tablist, not a <nav>: it switches
 * the one panel the page shows (only the active panel is mounted), and only
 * the tablist is labelled, so it is announced once. The arrows, Home and End
 * move between the tabs and select as they go (automatic activation); they
 * never reach the window's month keys.
 */
export default function ViewTabs({ view, onChange }: Props) {
  const { t } = useLang()
  const refs = useRef(new Map<AppView, HTMLButtonElement>())

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const at = APP_VIEWS.indexOf(view)
    let next: number | null = null
    if (e.key === 'ArrowLeft') next = (at - 1 + APP_VIEWS.length) % APP_VIEWS.length
    else if (e.key === 'ArrowRight') next = (at + 1) % APP_VIEWS.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = APP_VIEWS.length - 1
    if (next === null) return
    e.preventDefault()
    // The window's handler would change the month as well.
    e.stopPropagation()
    const target = APP_VIEWS[next]
    if (target !== view) onChange(target)
    refs.current.get(target)?.focus()
  }

  return (
    <div className="app-views">
      <div className="scope-toggle view-toggle" role="tablist" aria-label={t('view.aria')} onKeyDown={onKey}>
        {APP_VIEWS.map((v) => (
          <button
            key={v}
            ref={(el) => {
              if (el) refs.current.set(v, el)
              else refs.current.delete(v)
            }}
            type="button"
            role="tab"
            id={`view-tab-${v}`}
            className={`scope-btn view-tab view-tab-${v}${v === view ? ' active' : ''}`}
            aria-selected={v === view}
            // Only the active panel exists, so only its tab points at one.
            aria-controls={v === view ? `view-panel-${v}` : undefined}
            tabIndex={v === view ? 0 : -1}
            onClick={() => onChange(v)}
          >
            {t(`view.${v}`)}
          </button>
        ))}
      </div>
    </div>
  )
}
