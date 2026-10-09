import { todayStr } from '../lib/dates'
import { useLang } from '../lib/i18n'
import { RANGE_KINDS, rangeBounds, type DateRange } from '../lib/range'

interface Props {
  range: DateRange
  onChange: (range: DateRange) => void
}

/** The lens over the stats: a row of ranges, plus two date boxes when it is a custom one. */
export default function RangeBar({ range, onChange }: Props) {
  const { t } = useLang()

  const pick = (kind: DateRange['kind']): void => {
    if (kind !== 'custom') {
      onChange({ kind })
      return
    }
    // Custom starts from this month so the boxes are never blank.
    const month = rangeBounds({ kind: 'month' }, todayStr())
    onChange({ kind: 'custom', from: range.from ?? month.from ?? undefined, to: range.to ?? todayStr() })
  }

  return (
    <div className="range-bar">
      <div className="scope-toggle range-toggle" role="group" aria-label={t('range.aria')}>
        {RANGE_KINDS.map((k) => (
          <button key={k} type="button" className={`scope-btn ${range.kind === k ? 'active' : ''}`} aria-pressed={range.kind === k} onClick={() => pick(k)}>
            {t(`range.${k}`)}
          </button>
        ))}
      </div>
      {range.kind === 'custom' && (
        <div className="range-custom">
          <label>
            <span>{t('range.from')}</span>
            <input type="date" value={range.from ?? ''} max={range.to} onChange={(e) => onChange({ ...range, from: e.target.value || undefined })} />
          </label>
          <label>
            <span>{t('range.to')}</span>
            <input type="date" value={range.to ?? ''} min={range.from} onChange={(e) => onChange({ ...range, to: e.target.value || undefined })} />
          </label>
        </div>
      )}
    </div>
  )
}
