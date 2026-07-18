import { DownloadIcon, PlusIcon, SparkIcon } from './icons'

interface Props {
  email: string | null
  canExport: boolean
  onExport: () => void
  onLogToday: () => void
  onSignOut: () => void
}

export default function Header({ email, canExport, onExport, onLogToday, onSignOut }: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">
          <SparkIcon size={18} />
        </span>
        <h1>
          Bet<span>Tracker</span>
        </h1>
        <span className="sync-badge" title="Your bets sync across every signed-in device">
          <i className="sync-dot" /> Synced
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
