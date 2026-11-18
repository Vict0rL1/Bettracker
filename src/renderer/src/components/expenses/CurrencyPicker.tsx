import { useId } from 'react'
import { currencyName, currencyOptions } from '../../lib/currency'
import { useLang } from '../../lib/i18n'

interface Props {
  currency: string
  /** Settings loaded and 008 proven: a change can be saved. */
  enabled: boolean
  onChange: (code: string) => void
}

/** The currency the expenses are shown in. Converts nothing; the bets stay in dollars. */
export default function CurrencyPicker({ currency, enabled, onChange }: Props) {
  const { t, lang } = useLang()
  const id = useId()
  return (
    <section className="expset-section expset-currency" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{t('expset.currency')}</h3>
      <select
        className="currency-select"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-hint`}
        value={currency}
        disabled={!enabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {currencyOptions(currency).map((code) => (
          <option key={code} value={code}>
            {code} — {currencyName(code, lang)}
          </option>
        ))}
      </select>
      <p className="hint" id={`${id}-hint`}>
        {t('expset.currencyHint')}
      </p>
    </section>
  )
}
