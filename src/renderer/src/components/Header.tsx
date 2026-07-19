import type { SyncStatus } from '../data/useEntrySync'
import { DownloadIcon, PlusIcon, SparkIcon } from './icons'

interface Props {
  email: string | null
  status: SyncStatus
  pendingCount: number
  canExport: boolean
  onExport: () => void
  onLogToday: () => void
  onSignOut: () => void
}

const BADGE: Record<SyncStatus, { label: (n: number) => string; title: string }> = {
  synced: {
    label: () => 'Synced',
    title: 'All changes are saved to the cloud and shared with your other devices'
  },
  syncing: {
    label: (n) => (n > 0 ? `Syncing ${n}…` : 'Syncing…'),
    title: 'Saving queued changes to the cloud…'
  },
  offline: {
    label: (n) => (n > 0 ? `Offline · ${n} queued` : 'Offline'),
    title: 'No connection — changes are saved on this device and will sync automatically when you are back online'
  }
}

export default function Header({ email, status, pendingCount, canExport, onExport, onLogToday, onSignOut }: Props) {
  const badge = BADGE[status]
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
          <i className="sync-dot" /> {badge.label(pendingCount)}
        </span>
      </div>
      <div className="topbar-actions">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!canExport}
          onClick={onExport}
          title={canExport ? 'Download all entries as a CSV file' : 'Nothing to export yet'}
        >
          <DownloadIcon /> Export CSV
        </button>
        <button type="button" className="btn btn-primary" onClick={onLogToday}>
          <PlusIcon /> Log today
        </button>
        <div className="account">
          {email && <span className="account-email" title={email}>{email}</span>}
          <button type="button" className="btn btn-ghost btn-signout" onClick={onSignOut} title="Sign out">
            Sign out
          </button>
        </div>
      </div>
    </header>
  )
}
