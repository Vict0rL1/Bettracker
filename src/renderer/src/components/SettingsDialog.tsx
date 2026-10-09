import { useEffect, useId, useState } from 'react'
import { ODDS_FORMATS, type OddsFormat, type Settings, type SettingsPatch } from '../../../shared/types'
import { useLang } from '../lib/i18n'
import { formatOdds } from '../lib/odds'
import { MAX_AMOUNT, round2 } from '../lib/validate'
import { CloseIcon } from './icons'

interface Props {
  settings: Settings
  /** True while a change is still waiting to reach the server. */
  dirty: boolean
  onChange: (patch: SettingsPatch) => void
  onClose: () => void
}

/** The price each format button previews: −110 / 1.91 / 10/11, the one everyone knows. */
const SAMPLE = 1.9091

/**
 * Per-user preferences. Every control applies as soon as it changes — there
 * is no save button — and the change is queued for the server the same way a
 * bet is, so it works offline and follows the user to their other devices.
 */
export default function SettingsDialog({ settings, dirty, onChange, onClose }: Props) {
  const { t } = useLang()
  const titleId = useId()
  const stakeId = useId()
  const lossId = useId()
  const [stakeStr, setStakeStr] = useState(settings.defaultStake === null ? '' : String(settings.defaultStake))
  const [lossStr, setLossStr] = useState(settings.lossLimit === null ? '' : String(settings.lossLimit))

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const pickFormat = (f: OddsFormat): void => {
    if (f !== settings.oddsFormat) onChange({ oddsFormat: f })
  }

  /** The stake box commits on blur or Enter; nonsense reverts to the saved value. */
  const commitStake = (): void => {
    const text = stakeStr.trim()
    if (text === '') {
      if (settings.defaultStake !== null) onChange({ defaultStake: null })
      return
    }
    const n = parseFloat(text)
    if (Number.isFinite(n) && n >= 0 && n <= MAX_AMOUNT) {
      const r = round2(n)
      setStakeStr(String(r))
      if (r !== settings.defaultStake) onChange({ defaultStake: r })
    } else {
      setStakeStr(settings.defaultStake === null ? '' : String(settings.defaultStake))
    }
  }

  /** Same for the loss limit; zero or empty means no limit. */
  const commitLoss = (): void => {
    const text = lossStr.trim()
    const n = text === '' ? 0 : parseFloat(text)
    if (Number.isFinite(n) && n >= 0 && n <= MAX_AMOUNT) {
      const next = n === 0 ? null : round2(n)
      setLossStr(next === null ? '' : String(next))
      if (next !== settings.lossLimit) onChange({ lossLimit: next })
    } else {
      setLossStr(settings.lossLimit === null ? '' : String(settings.lossLimit))
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal card settings-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal-head">
          <h2 id={titleId}>{t('settings.title')}</h2>
          <button type="button" className="btn-icon" aria-label={t('common.close')} onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        <div className="settings-row">
          <span className="field-label">{t('settings.oddsFormat')}</span>
          <div className="seg settings-seg" role="group" aria-label={t('settings.oddsFormat')}>
            {ODDS_FORMATS.map((f) => (
              <button key={f} type="button" className={`seg-btn ${settings.oddsFormat === f ? 'active' : ''}`} aria-pressed={settings.oddsFormat === f} onClick={() => pickFormat(f)}>
                <span>{t(`odds.${f}`)}</span>
                <span className="seg-sample">{formatOdds(SAMPLE, f)}</span>
              </button>
            ))}
          </div>
          <p className="hint">{t('settings.oddsHint')}</p>
        </div>

        <div className="settings-row">
          <label className="field settings-stake" htmlFor={stakeId}>
            <span className="field-label">
              {t('settings.defaultStake')} <span className="field-opt">{t('common.optional')}</span>
            </span>
            <div className="amount-wrap">
              <span className="amount-cur">$</span>
              <input
                id={stakeId}
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={stakeStr}
                onChange={(e) => setStakeStr(e.target.value)}
                onBlur={commitStake}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitStake()
                  }
                }}
              />
            </div>
          </label>
          <p className="hint">{t('settings.defaultStakeHint')}</p>
        </div>

        <div className="settings-row">
          <label className="field settings-loss" htmlFor={lossId}>
            <span className="field-label">
              {t('settings.lossLimit')} <span className="field-opt">{t('common.optional')}</span>
            </span>
            <div className="amount-wrap">
              <span className="amount-cur">$</span>
              <input
                id={lossId}
                type="number"
                inputMode="decimal"
                min="0"
                step="1"
                placeholder="0"
                value={lossStr}
                onChange={(e) => setLossStr(e.target.value)}
                onBlur={commitLoss}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitLoss()
                  }
                }}
              />
            </div>
          </label>
          <p className="hint">{t('settings.lossLimitHint')}</p>
        </div>

        <footer className="modal-actions">
          <span className={`settings-sync ${dirty ? 'is-dirty' : ''}`} aria-live="polite">
            {dirty ? t('settings.pending') : ''}
          </span>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.done')}
          </button>
        </footer>
      </div>
    </div>
  )
}
