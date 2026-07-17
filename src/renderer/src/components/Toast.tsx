import { useEffect } from 'react'

export interface ToastMsg {
  kind: 'ok' | 'error'
  text: string
}

interface Props {
  msg: ToastMsg
  onDone: () => void
}

export default function Toast({ msg, onDone }: Props) {
  useEffect(() => {
    const t = setTimeout(onDone, 4200)
    return () => clearTimeout(t)
  }, [msg, onDone])

  return (
    <div className={`toast ${msg.kind}`} role="status">
      {msg.text}
    </div>
  )
}
