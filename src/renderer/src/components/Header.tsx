import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { SyncStatus } from '../data/useBetSync'
import { useLang } from '../lib/i18n'
import type { Theme } from '../lib/theme'
import type { AppView } from '../lib/view'
import { ArchiveIcon, ClockIcon, GlobeIcon, MenuIcon, MoonIcon, PlusIcon, SignOutIcon, SlidersIcon, SparkIcon, SunIcon } from './icons'

interface Props {
  email: string | null
  /** 'signedout': the session ended and changes wait for a sign-in. */
  status: SyncStatus | 'signedout'
  /** Rows waiting to reach the server (not bets awaiting a result). */
  queuedCount: number
  /** Bets still waiting for a result. */
  pendingCount: number
  /** Changes this device has not got to the server yet (bets, deposits and withdrawals, expenses, cards and budgets, settings). */
  unsynced: number
  theme: Theme
  /** Import, export, backups (see DataDialog). */
  onOpenData: () => void
  onToggleTheme: () => void
  onOpenSettings: () => void
  onOpenPending: () => void
  /** The view open below (see ViewTabs): it decides the primary button. */
  view: AppView
  /** The quick add, for today (the same sheet as the + button on a phone). */
  onAddBet: () => void
  /** The expense sheet (the same as the + button on a phone, in the Expenses view). */
  onAddExpense: () => void
  onSignOut: () => void
}

/**
 * The top bar: the name, the sync badge, Add bet (Add expense in the
 * Expenses view), and a menu with the rest
 * (import and export, pending bets, settings, theme, language, the account
 * and signing out). The menu button counts the bets still waiting for a
 * result, so they show while the menu is closed.
 */
export default function Header({
  email,
  status,
  queuedCount,
  pendingCount,
  unsynced,
  theme,
  onOpenData,
  onToggleTheme,
  onOpenSettings,
  onOpenPending,
  view,
  onAddBet,
  onAddExpense,
  onSignOut
}: Props) {
  const { t, tn, lang, toggle: toggleLang } = useLang()
  const menuId = useId()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Signing out wipes this device's copy, queue included. With changes still
  // waiting (offline, or held back by a missing migration) the first click
  // only says so; a second one within a few seconds signs out anyway.
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  useEffect(() => {
    if (!confirmSignOut) return
    const timer = setTimeout(() => setConfirmSignOut(false), 4000)
    return () => clearTimeout(timer)
  }, [confirmSignOut])
  const signOut = (): void => {
    if (unsynced > 0 && !confirmSignOut) setConfirmSignOut(true)
    else {
      setOpen(false)
      onSignOut()
    }
  }
  const signOutTitle = unsynced > 0 ? t('header.signOutUnsyncedTitle', { changes: tn('change', unsynced) }) : t('header.signOut')

  const items = (): HTMLElement[] => [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]

  // Opened, the first item takes the focus; a press or a tap outside closes it.
  useEffect(() => {
    if (!open) return
    items()[0]?.focus()
    const onDown = (e: PointerEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  /** Close and hand the focus back to the menu button, so a dialog opened from here returns it there. */
  const close = (): void => {
    setOpen(false)
    toggleRef.current?.focus()
  }
  /** An item that opens something: the menu closes first. */
  const pick = (action: () => void) => (): void => {
    close()
    action()
  }

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const list = items()
    const at = list.indexOf(document.activeElement as HTMLElement)
    const go = (i: number): void => list[(i + list.length) % list.length]?.focus()
    switch (e.key) {
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        close()
        break
      case 'ArrowDown':
        e.preventDefault()
        go(at + 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        go(at - 1)
        break
      case 'Home':
        e.preventDefault()
        go(0)
        break
      case 'End':
        e.preventDefault()
        go(list.length - 1)
        break
      case 'Tab':
        // Out of the menu: it closes behind the focus.
        setOpen(false)
        break
    }
  }

  const badge =
    status === 'synced'
      ? { label: t('sync.synced'), title: t('sync.syncedTitle') }
      : status === 'syncing'
        ? { label: queuedCount > 0 ? t('sync.syncingN', { n: queuedCount }) : t('sync.syncing'), title: t('sync.syncingTitle') }
        : status === 'behind'
          ? { label: queuedCount > 0 ? t('sync.behindN', { n: queuedCount }) : t('sync.behind'), title: t('sync.behindTitle') }
          : status === 'paused'
            ? { label: queuedCount > 0 ? t('sync.pausedN', { n: queuedCount }) : t('sync.paused'), title: t('sync.pausedTitle') }
            : status === 'retrying'
              ? { label: queuedCount > 0 ? t('sync.retryingN', { n: queuedCount }) : t('sync.retrying'), title: t('sync.retryingTitle') }
              : status === 'signedout'
                ? { label: queuedCount > 0 ? t('sync.signedoutN', { n: queuedCount }) : t('sync.signedout'), title: t('sync.signedoutTitle') }
                : { label: queuedCount > 0 ? t('sync.offlineN', { n: queuedCount }) : t('sync.offline'), title: t('sync.offlineTitle') }

  const menuLabel = pendingCount > 0 ? t('menu.labelPending', { n: pendingCount }) : t('menu.label')

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">
          <SparkIcon size={18} />
        </span>
        <h1>
          Bet<span>Tracker</span>
        </h1>
        <span className={`sync-badge ${status}`} title={badge.title}>
          <i className="sync-dot" /> {badge.label}
        </span>
      </div>
      <div className="topbar-actions">
        {/* One primary action, the open view's: Add bet keeps its words and is never relabelled. */}
        {view === 'bets' ? (
          <button type="button" className="btn btn-primary add-bet-btn" onClick={onAddBet} title={t('header.addBetTitle')}>
            <PlusIcon /> {t('header.addBet')}
          </button>
        ) : (
          <button type="button" className="btn btn-primary add-expense-btn" onClick={onAddExpense} title={t('header.addExpenseTitle')}>
            <PlusIcon /> {t('header.addExpense')}
          </button>
        )}
        <div className="menu-wrap" ref={wrapRef}>
          <button
            ref={toggleRef}
            type="button"
            className={`menu-btn ${open ? 'is-open' : ''}`}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            aria-label={menuLabel}
            title={menuLabel}
            onClick={() => setOpen((o) => !o)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && !open) {
                e.preventDefault()
                setOpen(true)
              }
            }}
          >
            <MenuIcon />
            {pendingCount > 0 && (
              <span className="pending-badge" aria-hidden="true">
                {pendingCount}
              </span>
            )}
          </button>
          {open && (
            <div className="card app-menu" role="menu" id={menuId} aria-label={t('menu.label')} ref={menuRef} onKeyDown={onMenuKey}>
              {email && (
                <div className="menu-account" role="none">
                  <span className="menu-account-label">{t('menu.signedInAs')}</span>
                  <span className="account-email" title={email}>
                    {email}
                  </span>
                </div>
              )}
              <button type="button" role="menuitem" className="menu-item data-btn" onClick={pick(onOpenData)} title={t('header.dataTitle')}>
                <ArchiveIcon /> <span>{t('header.data')}</span>
              </button>
              <button type="button" role="menuitem" className="menu-item pending-btn" onClick={pick(onOpenPending)} title={t('header.pendingTitle', { n: pendingCount })}>
                <ClockIcon /> <span>{t('menu.pending')}</span>
                {pendingCount > 0 && <span className="pending-badge">{pendingCount}</span>}
              </button>
              <button type="button" role="menuitem" className="menu-item settings-btn" onClick={pick(onOpenSettings)}>
                <SlidersIcon /> <span>{t('header.settings')}</span>
              </button>
              <div className="menu-sep" role="separator" />
              {/* Toggles: the menu stays open, showing the change. */}
              <button type="button" role="menuitem" className="menu-item theme-btn" onClick={onToggleTheme}>
                {theme === 'dark' ? <SunIcon /> : <MoonIcon />} <span>{theme === 'dark' ? t('header.toLight') : t('header.toDark')}</span>
              </button>
              <button type="button" role="menuitem" className="menu-item lang-btn" onClick={toggleLang} title={t('header.langTitle')}>
                <GlobeIcon /> <span lang={lang === 'en' ? 'es' : 'en'}>{t('header.lang')}</span>
              </button>
              <div className="menu-sep" role="separator" />
              <button type="button" role="menuitem" className={`menu-item btn-signout ${confirmSignOut ? 'confirming' : ''}`} onClick={signOut} title={signOutTitle}>
                <SignOutIcon /> <span>{confirmSignOut ? t('header.signOutUnsynced') : t('header.signOut')}</span>
              </button>
              {confirmSignOut && (
                <span className="visually-hidden" role="alert">
                  {signOutTitle}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
