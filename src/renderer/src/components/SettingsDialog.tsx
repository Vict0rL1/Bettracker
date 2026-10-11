import { useEffect, useId, useRef, useState } from 'react'
import { ODDS_FORMATS, type OddsFormat, type Settings, type SettingsPatch } from '../../../shared/types'
import type { Bankroll } from '../lib/bankroll'
import { fmtStake, moneyFormat } from '../lib/format'
import { useLang } from '../lib/i18n'
import { formatOdds } from '../lib/odds'
import { parseMoneyBox, unitSizePatch } from '../lib/validate'
import { CloseIcon } from './icons'

interface Props {
  settings: Settings
  /** True while a change is still waiting to reach the server. */
  dirty: boolean
  /** True when what it waits for is a database migration, not the connection. */
  blocked: boolean
  bankroll: Bankroll
  onChange: (patch: SettingsPatch) => void
  /** Closes Settings and opens the Bankroll dialog (dialogs never stack). */
  onOpenBankroll: () => void
  onClose: () => void
}

/** The price each format button previews: −110 / 1.91 / 10/11, the one everyone knows. */
const SAMPLE = 1.9091

/**
 * Per-user preferences. Every control applies as soon as it changes — there
 * is no save button — and the change is queued for the server the same way a
 * bet is, so it works offline and follows the user to their other devices.
 */
export default function SettingsDialog({ settings, dirty, blocked, bankroll, onChange, onOpenBankroll, onClose }: Props) {
  const { t } = useLang()
  const titleId = useId()
  const stakeId = useId()
  const lossId = useId()
  const unitId = useId()
  const unitsHintId = useId()
  const [stakeStr, setStakeStr] = useState(settings.defaultStake === null ? '' : String(settings.defaultStake))
  const [lossStr, setLossStr] = useState(settings.lossLimit === null ? '' : String(settings.lossLimit))
  const [unitStr, setUnitStr] = useState(settings.unitSize === null ? '' : String(settings.unitSize))

  const pickFormat = (f: OddsFormat): void => {
    if (f !== settings.oddsFormat) onChange({ oddsFormat: f })
  }

  // The boxes commit on blur or Enter, and nonsense reverts to the saved
  // value. Values are checked once rounded to cents, as the database checks
  // them: a value it refuses would take the whole queued change with it.

  /** The default stake: empty means none, 0 is allowed (a free bet). */
  const commitStake = (): void => {
    const parsed = parseMoneyBox(stakeStr, { allowZero: true })
    if (parsed === 'invalid') {
      setStakeStr(settings.defaultStake === null ? '' : String(settings.defaultStake))
      return
    }
    setStakeStr(parsed === null ? '' : String(parsed))
    if (parsed !== settings.defaultStake) onChange({ defaultStake: parsed })
  }

  /** The loss limit: zero or empty means no limit (0.004 too: it is $0.00). */
  const commitLoss = (): void => {
    const parsed = parseMoneyBox(lossStr, { allowZero: true })
    if (parsed === 'invalid') {
      setLossStr(settings.lossLimit === null ? '' : String(settings.lossLimit))
      return
    }
    const next = parsed === 0 ? null : parsed
    setLossStr(next === null ? '' : String(next))
    if (next !== settings.lossLimit) onChange({ lossLimit: next })
  }

  /** The unit size: empty means none, and clearing it turns units off with it. */
  const commitUnit = (): void => {
    const patch = unitSizePatch(unitStr, settings)
    if (patch === 'revert') {
      setUnitStr(settings.unitSize === null ? '' : String(settings.unitSize))
      return
    }
    if (patch !== null) {
      setUnitStr(patch.unitSize === undefined || patch.unitSize === null ? '' : String(patch.unitSize))
      onChange(patch)
    }
  }

  // Escape and the backdrop close the dialog without a blur: commit what was
  // typed first, so it is not lost on the way out.
  const commitAll = useRef<() => void>(() => {})
  commitAll.current = () => {
    commitStake()
    commitLoss()
    commitUnit()
  }
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const close = (): void => {
    commitAll.current()
    closeRef.current()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        commitAll.current()
        closeRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const sample = settings.defaultStake ?? 50
  const unitsReady = settings.unitSize !== null && settings.unitSize > 0
  // In dollars here, like the starting bankroll it is set up from.
  const bankrollText = bankroll.known ? moneyFormat(null).bankroll(bankroll.current) : bankroll.reason === 'unset' ? t('settings.bankrollNotSet') : '…'

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="modal card settings-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal-head">
          <h2 id={titleId}>{t('settings.title')}</h2>
          <button type="button" className="btn-icon" aria-label={t('common.close')} onClick={close}>
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
          <label className="field settings-unit" htmlFor={unitId}>
            <span className="field-label">
              {t('settings.unitSize')} <span className="field-opt">{t('common.optional')}</span>
            </span>
            <div className="amount-wrap">
              <span className="amount-cur">$</span>
              <input
                id={unitId}
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                placeholder="0.00"
                value={unitStr}
                onChange={(e) => setUnitStr(e.target.value)}
                onBlur={commitUnit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitUnit()
                  }
                }}
              />
            </div>
          </label>
          <p className="hint">{t('settings.unitSizeHint')}</p>
        </div>

        <div className="settings-row">
          <span className="field-label">{t('settings.showIn')}</span>
          <div className="seg settings-seg seg-2 settings-units" role="group" aria-label={t('settings.showIn')}>
            <button type="button" className={`seg-btn ${!settings.showUnits ? 'active' : ''}`} aria-pressed={!settings.showUnits} onClick={() => settings.showUnits && onChange({ showUnits: false })}>
              <span>{t('settings.dollars')}</span>
              <span className="seg-sample">{fmtStake(sample)}</span>
            </button>
            <button
              type="button"
              className={`seg-btn ${settings.showUnits ? 'active' : ''}`}
              aria-pressed={settings.showUnits}
              disabled={!unitsReady}
              aria-describedby={unitsReady ? undefined : unitsHintId}
              onClick={() => !settings.showUnits && onChange({ showUnits: true })}
            >
              <span>{t('settings.units')}</span>
              <span className="seg-sample">{unitsReady ? moneyFormat(settings.unitSize).stake(sample) : '—'}</span>
            </button>
          </div>
          <p className="hint" id={unitsHintId}>
            {unitsReady ? t('settings.unitsHint') : t('settings.unitsNeedSize')}
          </p>
        </div>

        <div className="settings-row settings-bankroll">
          <span className="field-label">{t('settings.bankroll')}</span>
          <div className="settings-bankroll-line">
            <span className="settings-bankroll-value">{bankrollText}</span>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                commitAll.current()
                onOpenBankroll()
              }}
            >
              {bankroll.known === false && bankroll.reason === 'unset' ? t('settings.setUp') : t('settings.manage')}
            </button>
          </div>
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
            {dirty ? t(blocked ? 'settings.blocked' : 'settings.pending') : ''}
          </span>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={close}>
            {t('common.done')}
          </button>
        </footer>
      </div>
    </div>
  )
}
