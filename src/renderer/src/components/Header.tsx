import { useRef } from 'react'
import type { SyncStatus } from '../data/useBetSync'
import { useLang } from '../lib/i18n'
import type { Theme } from '../lib/theme'
import { ClockIcon, DownloadIcon, MoonIcon, PlusIcon, SlidersIcon, SparkIcon, SunIcon, UploadIcon } from './icons'

interface Props {
  email: string | null
  status: SyncStatus
  /** Rows waiting to reach the server (not bets awaiting a result). */
  queuedCount: number
  /** Bets still waiting for a result. */
  pendingCount: number
  canExport: boolean
  theme: Theme
  onExport: () => void
  onImport: (file: File) => void
  onToggleTheme: () => void
  onOpenSettings: () => void
  onOpenPending: () => void
  onLogToday: () => void
  onSignOut: () => void
}

export default function Header({
  email,
  status,
  queuedCount,
  pendingCount,
  canExport,
  theme,
  onExport,
  onImport,
  onToggleTheme,
  onOpenSettings,
  onOpenPending,
  onLogToday,
  onSignOut
}: Props) {
  const { t, toggle: toggleLang } = useLang()
  const fileRef = useRef<HTMLInputElement>(null)

  const badge =
    status === 'synced'
      ? { label: t('sync.synced'), title: t('sync.syncedTitle') }
      : status === 'syncing'
        ? { label: queuedCount > 0 ? t('sync.syncingN', { n: queuedCount }) : t('sync.syncing'), title: t('sync.syncingTitle') }
        : status === 'behind'
          ? { label: t('sync.behindN', { n: queuedCount }), title: t('sync.behindTitle') }
          : { label: queuedCount > 0 ? t('sync.offlineN', { n: queuedCount }) : t('sync.offline'), title: t('sync.offlineTitle') }

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
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="visually-hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onImport(file)
            // Reset so picking the same file twice still fires a change event.
            e.target.value = ''
          }}
        />
        <button type="button" className="btn btn-ghost" onClick={() => fileRef.current?.click()} title={t('header.importTitle')}>
          <UploadIcon /> {t('header.import')}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!canExport}
          onClick={onExport}
          title={canExport ? t('header.exportTitle') : t('header.exportEmpty')}
        >
          <DownloadIcon /> {t('header.export')}
        </button>
        <button type="button" className={`btn btn-ghost pending-btn ${pendingCount > 0 ? 'has-open' : ''}`} onClick={onOpenPending} title={t('header.pendingTitle', { n: pendingCount })}>
          <ClockIcon /> {t('header.pending')}
          {pendingCount > 0 && <span className="pending-badge">{pendingCount}</span>}
        </button>
        <button
          type="button"
          className="btn-icon theme-btn"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? t('header.toLight') : t('header.toDark')}
          title={theme === 'dark' ? t('header.toLight') : t('header.toDark')}
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>
        <button type="button" className="btn-icon lang-btn" onClick={toggleLang} title={t('header.langTitle')} aria-label={t('header.langTitle')}>
          {t('header.lang')}
        </button>
        <button type="button" className="btn-icon theme-btn settings-btn" onClick={onOpenSettings} aria-label={t('header.settings')} title={t('header.settings')}>
          <SlidersIcon />
        </button>
        <button type="button" className="btn btn-primary" onClick={onLogToday}>
          <PlusIcon /> {t('header.logToday')}
        </button>
        <div className="account">
          {email && (
            <span className="account-email" title={email}>
              {email}
            </span>
          )}
          <button type="button" className="btn btn-ghost btn-signout" onClick={onSignOut} title={t('header.signOut')}>
            {t('header.signOut')}
          </button>
        </div>
      </div>
    </header>
  )
}
