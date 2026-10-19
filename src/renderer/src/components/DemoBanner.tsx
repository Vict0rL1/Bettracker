import { useEffect, useState } from 'react'
import { resetDemo } from '../demo/demo'
import { useLang } from '../lib/i18n'

/** The demo's line across the top: where its data lives, and a way to start over (asks twice). */
export default function DemoBanner() {
  const { t } = useLang()
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), 4000)
    return () => clearTimeout(timer)
  }, [confirming])

  const reset = (): void => {
    if (!confirming) {
      setConfirming(true)
      return
    }
    resetDemo()
    location.reload()
  }

  return (
    <div className="demo-banner" role="note">
      <span>{t('demo.banner')}</span>
      <button type="button" className={`btn btn-ghost demo-reset ${confirming ? 'confirming' : ''}`} onClick={reset}>
        {confirming ? t('demo.resetConfirm') : t('demo.reset')}
      </button>
    </div>
  )
}
