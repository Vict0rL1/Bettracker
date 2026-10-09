import { useEffect } from 'react'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastMsg {
  kind: 'ok' | 'error'
  text: string
  /** An offer the toast makes, e.g. Undo. The toast stays up longer when it has one. */
  action?: ToastAction
}

interface Props {
  msg: ToastMsg
  onDone: () => void
}

export default function Toast({ msg, onDone }: Props) {
  useEffect(() => {
    const t = setTimeout(onDone, msg.action ? 8000 : 4200)
    return () => clearTimeout(t)
  }, [msg, onDone])

  return (
    <div className={`toast ${msg.kind}`} role="status">
      <span className="toast-text">{msg.text}</span>
      {msg.action && (
        <button type="button" className="toast-action" onClick={msg.action.onClick}>
          {msg.action.label}
        </button>
      )}
    </div>
  )
}
