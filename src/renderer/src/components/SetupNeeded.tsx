import { SparkIcon } from './icons'

/** Shown when the app has no Supabase credentials yet — guides first-time setup. */
export default function SetupNeeded() {
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
        <p className="auth-tag">Almost there — connect your Supabase project to enable cross-device sync.</p>

        <ol className="setup-steps">
          <li>
            Create a free project at <code>supabase.com</code>.
          </li>
          <li>
            Run the SQL in <code>supabase/schema.sql</code> from the project's SQL editor.
          </li>
          <li>
            Copy <code>.env.example</code> to <code>.env</code> and fill in your project URL and anon key
            (Project Settings → API).
          </li>
          <li>
            Restart the app (<code>npm run dev</code>).
          </li>
        </ol>

        <p className="setup-foot">Full instructions are in the README.</p>
      </div>
    </div>
  )
}
