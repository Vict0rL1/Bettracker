import { useLang } from '../lib/i18n'
import { SparkIcon } from './icons'

/** Renders "{name}" placeholders in a translated line as <code> elements. */
function Line({ text, parts }: { text: string; parts: Record<string, string> }) {
  const out: (string | React.ReactElement)[] = []
  const re = /\{(\w+)\}/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push(text.slice(last, m.index))
    out.push(<code key={m.index}>{parts[m[1]] ?? m[0]}</code>)
    last = m.index + m[0].length
  }
  out.push(text.slice(last))
  return <>{out}</>
}

/** Shown when the app has no Supabase credentials yet — guides first-time setup. */
export default function SetupNeeded() {
  const { t } = useLang()
  return (
    <div className="auth-screen">
      <div className="card auth-card setup-card">
        <div className="auth-brand">
          <span className="brand-mark">
            <SparkIcon size={20} />
          </span>
          <h1>
            Bet<span>Tracker</span>
          </h1>
        </div>
        <p className="auth-tag">{t('setup.tag')}</p>

        <ol className="setup-steps">
          <li>
            <Line text={t('setup.step1')} parts={{ site: 'supabase.com' }} />
          </li>
          <li>
            <Line text={t('setup.step2')} parts={{ file: 'supabase/schema.sql' }} />
          </li>
          <li>
            <Line text={t('setup.step3')} parts={{ example: '.env.example', env: '.env' }} />
          </li>
          <li>
            <Line text={t('setup.step4')} parts={{ cmd: 'npm run dev' }} />
          </li>
        </ol>

        <p className="setup-foot">{t('setup.foot')}</p>
      </div>
    </div>
  )
}
