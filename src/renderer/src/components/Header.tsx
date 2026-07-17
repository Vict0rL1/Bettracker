import { DownloadIcon, PlusIcon, SparkIcon } from './icons'

interface Props {
  canExport: boolean
  onExport: () => void
  onLogToday: () => void
}

export default function Header({ canExport, onExport, onLogToday }: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">
          <SparkIcon size={18} />
        </span>
        <h1>
          Bet<span>Tracker</span>
        </h1>
      </div>
      <div className="topbar-actions">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!canExport}
          onClick={onExport}
          title={canExport ? 'Export all entries to a CSV file' : 'Nothing to export yet'}
        >
          <DownloadIcon /> Export CSV
        </button>
        <button type="button" className="btn btn-primary" onClick={onLogToday}>
          <PlusIcon /> Log today
        </button>
      </div>
    </header>
  )
}
