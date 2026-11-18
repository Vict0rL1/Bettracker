import { useEffect, useState } from 'react'
import { demoHasData, resetDemo } from '../demo/demo'
import { loadSampleData } from '../demo/sample'
import { useLang } from '../lib/i18n'

/**
 * The demo's line across the top: where its data lives, a way to fill it with
 * sample data (two months of bets and expenses, to see the app full) and a
 * way to start over. Whatever would delete something asks twice: "Start
 * over" always, "Load sample data" when the demo already holds data.
 */
export default function DemoBanner() {
  const { t, lang } = useLang()
  const [confirming, setConfirming] = useState<'reset' | 'sample' | null>(null)

  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(null), 4000)
    return () => clearTimeout(timer)
  }, [confirming])

  const reset = (): void => {
    if (confirming !== 'reset') {
      setConfirming('reset')
      return
    }
    resetDemo()
    location.reload()
  }

  const sample = (): void => {
    // Nothing to lose in an empty demo: no question.
    if (confirming !== 'sample' && demoHasData()) {
      setConfirming('sample')
      return
    }
    loadSampleData(lang)
    // The same page again (the view is the device's own setting), now reading the sample from the demo's server.
    location.reload()
  }

  return (
    <div className="demo-banner" role="note">
      <span>{t('demo.banner')}</span>
      <button type="button" className={`btn btn-ghost demo-sample ${confirming === 'sample' ? 'confirming' : ''}`} onClick={sample}>
        {confirming === 'sample' ? t('demo.sampleConfirm') : t('demo.sample')}
      </button>
      <button type="button" className={`btn btn-ghost demo-reset ${confirming === 'reset' ? 'confirming' : ''}`} onClick={reset}>
        {confirming === 'reset' ? t('demo.resetConfirm') : t('demo.reset')}
      </button>
    </div>
  )
}
