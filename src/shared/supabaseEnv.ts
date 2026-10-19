import type { Plugin } from 'vite'

/**
 * The two values the app is built with, VITE_SUPABASE_URL and
 * VITE_SUPABASE_ANON_KEY, checked for the mistakes that otherwise show up
 * late and vague: a blank page (a URL supabase-js refuses), "Invalid API key"
 * at sign-in (a key from another project), or a secret published inside the
 * app for anyone to read (the service_role key, the database password).
 *
 * Pure and offline. The build runs it on .env (`supabaseEnvCheck` below, in
 * vite.config.ts and electron.vite.config.ts) and stops on a problem; the app
 * runs it on what it was built with (lib/supabase.ts), so `npm run dev` with a
 * bad .env explains itself on the setup screen. A key that passes can still be
 * refused by Supabase (a publishable key carries no project to compare); the
 * sign-in screen explains that one.
 */

/** One thing wrong with the two values. `fix` is the value to use instead, when it can be told. */
export type EnvProblem =
  | { code: 'url-missing' }
  | { code: 'key-missing' }
  | { code: 'url-example' }
  | { code: 'url-no-https'; fix: string }
  | { code: 'url-dashboard'; fix: string | null }
  | { code: 'url-database'; fix: string | null }
  | { code: 'url-path'; fix: string }
  | { code: 'url-invalid' }
  | { code: 'key-example' }
  | { code: 'key-secret' }
  | { code: 'key-role'; role: string }
  | { code: 'key-damaged' }
  | { code: 'key-unknown' }
  | { code: 'key-other-project'; keyRef: string; urlRef: string }

/**
 * - 'unset': neither value — the app shows its setup steps;
 * - 'bad':   at least one problem, URL first;
 * - 'ok':    nothing that can't work. `legacyKey`: the key is the old anon
 *            JWT, which Supabase is retiring. `warnings`: what is likely
 *            wrong but can't be told for sure offline — an anon key whose
 *            project isn't the URL's (a vanity subdomain can look like a ref).
 */
export type EnvCheck =
  | { status: 'unset' }
  | { status: 'bad'; problems: EnvProblem[] }
  | { status: 'ok'; legacyKey: boolean; warnings: EnvProblem[] }

/** `https://<ref>.supabase.co` */
const projectUrl = (ref: string): string => `https://${ref.toLowerCase()}.supabase.co`

/** Supabase's own API paths: the URL is the part before them. */
const API_PATH = /\/(?:rest|auth|storage|realtime|functions|graphql)\/v1(?:\/|$)/i

/** A project ref is 20 lowercase letters; a vanity subdomain can be anything, so only these are compared. */
const REF = /^([a-z]{20})\.supabase\.co$/

interface UrlResult {
  problem: EnvProblem | null
  ref: string | null
}

function checkUrl(value: string): UrlResult {
  const bad = (problem: EnvProblem): UrlResult => ({ problem, ref: null })

  // A Postgres connection string. It carries the database password, so it
  // must never reach a bundle; the ref in it gives the URL to use instead.
  if (/^postgres(?:ql)?:\/\//i.test(value)) {
    const ref = /(?:@db\.|\/\/postgres\.)([a-z]{20})\b/i.exec(value)?.[1]
    return bad({ code: 'url-database', fix: ref ? projectUrl(ref) : null })
  }

  // The example in .env.example or the docs, still there: a <ref> or {ref}
  // anywhere, or a project label that is no project ("YOUR-PROJECT-ref",
  // "xxxxxxxx"). Only a hosted project's label is read for words: anywhere
  // else they could be real (a path, another host), and [] is IPv6.
  const label = /^(?:[a-z]+:\/\/)?([^/?#:]+)\.supabase\.co(?:[/?#:]|$)/i.exec(value)?.[1] ?? ''
  if (/[<>{}]/.test(value) || /your[-_ ]?project|project[-_ ]?ref|^x{3,}$|^xyzcompany$/i.test(label)) {
    return bad({ code: 'url-example' })
  }

  if (!/^https?:\/\//i.test(value)) {
    // "ref.supabase.co": only the scheme is missing (supabase-js refuses it,
    // and the page would stay blank).
    const bare = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)\/?$/i.exec(value)?.[1]
    return bad(bare ? { code: 'url-no-https', fix: `https://${bare.toLowerCase()}` } : { code: 'url-invalid' })
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return bad({ code: 'url-invalid' })
  }
  const hostname = url.hostname.toLowerCase()

  // The dashboard's address (supabase.com/dashboard/project/<ref>).
  if (hostname === 'supabase.com' || hostname === 'www.supabase.com' || hostname === 'app.supabase.com') {
    const ref = /\/project\/([a-z]{20})(?:\/|$)/i.exec(url.pathname)?.[1]
    return bad({ code: 'url-dashboard', fix: ref ? projectUrl(ref) : null })
  }

  const hosted = hostname.endsWith('.supabase.co')
  if (hosted && url.protocol === 'http:') return bad({ code: 'url-no-https', fix: `https://${hostname}` })

  // An API path, or anything after the address of a hosted project. (A
  // self-hosted Supabase may live under a path of its own; that one stays.)
  const api = API_PATH.exec(url.pathname)
  if (api || url.search || url.hash || (hosted && url.pathname !== '/')) {
    const base = api ? url.pathname.slice(0, api.index) : hosted ? '' : url.pathname
    return bad({ code: 'url-path', fix: `${url.protocol}//${url.host}${base}` })
  }

  return { problem: null, ref: REF.exec(hostname)?.[1] ?? null }
}

interface KeyResult {
  problem: EnvProblem | null
  ref: string | null
  legacy: boolean
}

type Claims = Record<string, unknown>

/** The claims of a well-formed JWT, or null for anything cut short or garbled. */
function jwtClaims(token: string): Claims | null {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return null
  const json = (part: string): unknown => JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')))
  try {
    const header = json(parts[0])
    const claims = json(parts[1])
    if (typeof header !== 'object' || header === null || typeof claims !== 'object' || claims === null) return null
    // Supabase signs its keys with HS256: 32 bytes, 43 characters.
    if ((header as Claims).alg === 'HS256' && parts[2].length !== 43) return null
    return claims as Claims
  } catch {
    return null
  }
}

function checkKey(key: string): KeyResult {
  const bad = (problem: EnvProblem): KeyResult => ({ problem, ref: null, legacy: false })

  if (/your[-_ ]?(?:anon|publishable|api|supabase)|anon[-_ ]?public[-_ ]?key|[<>[\]{}]|^x{4,}$/i.test(key)) return bad({ code: 'key-example' })
  // Spaces, quotes, a line break, or the "…" of a shortened copy.
  if (/[\s"'`…]|\.\.\./.test(key)) return bad({ code: 'key-damaged' })
  // Secret keys bypass row-level security: whoever opens the app could read
  // and change every account.
  if (key.startsWith('sb_secret_')) return bad({ code: 'key-secret' })
  if (key.startsWith('sb_publishable_')) {
    return /^sb_publishable_[A-Za-z0-9_-]+$/.test(key) ? { problem: null, ref: null, legacy: false } : bad({ code: 'key-damaged' })
  }
  if (key.startsWith('eyJ')) {
    const claims = jwtClaims(key)
    if (!claims) return bad({ code: 'key-damaged' })
    if (claims.role === 'service_role') return bad({ code: 'key-secret' })
    if (claims.role !== 'anon') return bad({ code: 'key-role', role: typeof claims.role === 'string' ? claims.role : '?' })
    // The CLI's local keys carry no ref.
    return { problem: null, ref: typeof claims.ref === 'string' ? claims.ref.toLowerCase() : null, legacy: true }
  }
  // The JWT secret, the database password, a user's token …
  return bad({ code: 'key-unknown' })
}

/** Checks the two values. Surrounding spaces are ignored, as dotenv and supabase-js ignore them. */
export function checkSupabaseEnv(url: string | undefined, key: string | undefined): EnvCheck {
  const u = url?.trim() ?? ''
  const k = key?.trim() ?? ''
  if (!u && !k) return { status: 'unset' }

  const urlResult: UrlResult = u ? checkUrl(u) : { problem: { code: 'url-missing' }, ref: null }
  const keyResult: KeyResult = k ? checkKey(k) : { problem: { code: 'key-missing' }, ref: null, legacy: false }
  const problems: EnvProblem[] = []
  if (urlResult.problem) problems.push(urlResult.problem)
  if (keyResult.problem) problems.push(keyResult.problem)
  if (problems.length > 0) return { status: 'bad', problems }
  // What Supabase answers with "Invalid API key" — unless the URL's label is
  // a vanity subdomain that happens to look like a ref: said, not stopped.
  const warnings: EnvProblem[] =
    urlResult.ref && keyResult.ref && urlResult.ref !== keyResult.ref ? [{ code: 'key-other-project', keyRef: keyResult.ref, urlRef: urlResult.ref }] : []
  return { status: 'ok', legacyKey: keyResult.legacy, warnings }
}

/**
 * The words for each problem, in both languages. lib/strings.ts takes them in
 * (the setup screen shows them); the build prints them. `{url}`, `{key}` and
 * `{env}` name the variables and the file, `{fix}` is the value to use.
 */
const envEn = {
  'env.url-missing': '{key} is set but {url} is empty. Add your project URL, which looks like https://<ref>.supabase.co.',
  'env.key-missing': '{url} is set but {key} is empty. Add your project’s publishable key (sb_publishable_…, under Project Settings → API Keys).',
  'env.url-example': '{url} is still the example. Put your project URL, which looks like https://<ref>.supabase.co.',
  'env.url-no-https': '{url} has to start with https://. Use {fix}.',
  'env.url-dashboard': '{url} is the address of the Supabase dashboard, not of your project. Use {fix}.',
  'env.url-dashboard-noref': '{url} is the address of the Supabase dashboard, not of your project, which looks like https://<ref>.supabase.co.',
  'env.url-database':
    '{url} is the database connection string, and it includes the database password: never put it in the app. Use {fix}.',
  'env.url-database-noref':
    '{url} is the database connection string, and it includes the database password: never put it in the app. Use your project URL, which looks like https://<ref>.supabase.co.',
  'env.url-path': '{url} should be only the project’s address, with nothing after it. Use {fix}.',
  'env.url-invalid': '{url} is not a web address. It should look like https://<ref>.supabase.co.',
  'env.key-example': '{key} is still the example. Put your project’s publishable key (sb_publishable_…, under Project Settings → API Keys).',
  'env.key-secret':
    '{key} is a secret key (sb_secret_… or service_role). It skips row-level security, so anyone who opened the app could read and change every account. Use the publishable key (sb_publishable_…). If a copy of the app with this key was ever published, rotate the key in Supabase.',
  'env.key-role': '{key} is a token for the role “{role}”, not your project’s public key. Use the publishable key (sb_publishable_…).',
  'env.key-damaged': '{key} looks cut short or has something extra in it (spaces, quotes, “…”). Copy it again with the copy button.',
  'env.key-unknown':
    '{key} is not a Supabase API key: those start with sb_publishable_ (or eyJ, for the old anon key). The JWT secret and the database password don’t go here.',
  'env.key-other-project':
    'The key in {key} is from another Supabase project ({keyRef}), not from the one in {url} ({urlRef}). Supabase answers that with “Invalid API key”. Copy the URL and the key from the same project.'
}

const envEs: Record<keyof typeof envEn, string> = {
  'env.url-missing': '{key} tiene valor pero {url} está vacía. Añade la URL de tu proyecto, que es como https://<ref>.supabase.co.',
  'env.key-missing': '{url} tiene valor pero {key} está vacía. Añade la clave publishable de tu proyecto (sb_publishable_…, en Project Settings → API Keys).',
  'env.url-example': '{url} sigue siendo el ejemplo. Pon la URL de tu proyecto, que es como https://<ref>.supabase.co.',
  'env.url-no-https': '{url} tiene que empezar por https://. Usa {fix}.',
  'env.url-dashboard': '{url} es la dirección del panel de Supabase, no la de tu proyecto. Usa {fix}.',
  'env.url-dashboard-noref': '{url} es la dirección del panel de Supabase, no la de tu proyecto, que es como https://<ref>.supabase.co.',
  'env.url-database':
    '{url} es la cadena de conexión de la base de datos y lleva su contraseña: no la pongas nunca en la app. Usa {fix}.',
  'env.url-database-noref':
    '{url} es la cadena de conexión de la base de datos y lleva su contraseña: no la pongas nunca en la app. Usa la URL de tu proyecto, que es como https://<ref>.supabase.co.',
  'env.url-path': '{url} tiene que ser solo la dirección del proyecto, sin nada detrás. Usa {fix}.',
  'env.url-invalid': '{url} no es una dirección web. Tiene que ser como https://<ref>.supabase.co.',
  'env.key-example': '{key} sigue siendo el ejemplo. Pon la clave publishable de tu proyecto (sb_publishable_…, en Project Settings → API Keys).',
  'env.key-secret':
    '{key} es una clave secreta (sb_secret_… o service_role). Se salta la seguridad por filas, así que cualquiera que abriera la app podría leer y cambiar todas las cuentas. Usa la clave publishable (sb_publishable_…). Si alguna vez publicaste la app con esta clave, cámbiala (rótala) en Supabase.',
  'env.key-role': '{key} es un token del rol «{role}», no la clave pública de tu proyecto. Usa la clave publishable (sb_publishable_…).',
  'env.key-damaged': '{key} parece cortada o lleva algo de más (espacios, comillas, «…»). Cópiala otra vez con el botón de copiar.',
  'env.key-unknown':
    '{key} no es una clave de API de Supabase: esas empiezan por sb_publishable_ (o por eyJ, la anon antigua). El JWT secret y la contraseña de la base de datos no van aquí.',
  'env.key-other-project':
    'La clave de {key} es de otro proyecto de Supabase ({keyRef}), no del de {url} ({urlRef}). Eso es lo que Supabase contesta con «Invalid API key». Copia la URL y la clave del mismo proyecto.'
}

export const envStrings = { en: envEn, es: envEs }

export type EnvStringKey = keyof typeof envEn

/** The string for a problem, and what fills it (the variable names are filled too). */
export function envMessage(p: EnvProblem): { key: EnvStringKey; vars: Record<string, string> } {
  const vars: Record<string, string> = { url: 'VITE_SUPABASE_URL', key: 'VITE_SUPABASE_ANON_KEY' }
  if ('fix' in p && p.fix) vars.fix = p.fix
  if (p.code === 'key-role') vars.role = p.role
  if (p.code === 'key-other-project') {
    vars.keyRef = p.keyRef
    vars.urlRef = p.urlRef
  }
  const noRef = (p.code === 'url-dashboard' || p.code === 'url-database') && !p.fix
  return { key: noRef ? `env.${p.code}-noref` : `env.${p.code}`, vars }
}

// What only the build prints.
const buildEn = {
  bad: 'BetTracker can’t be built with this .env:',
  again: 'Fix .env and run the build again.',
  legacy:
    'BetTracker: VITE_SUPABASE_ANON_KEY is the old anon key. It works for now, but Supabase is retiring the old keys by the end of 2026: switch to the publishable key (sb_publishable_…, under Project Settings → API Keys) and build again.',
  unset:
    'BetTracker: there is no VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY, so this build will open on the setup screen. To publish it, fill in .env first.',
  devBad: 'BetTracker: .env has a problem (the app shows it too):',
  likely: 'BetTracker: .env is probably wrong (the build goes on; check it):'
}

const buildEs: typeof buildEn = {
  bad: 'BetTracker no se puede compilar con este .env:',
  again: 'Corrige el .env y vuelve a lanzar el build.',
  legacy:
    'BetTracker: VITE_SUPABASE_ANON_KEY es la clave anon antigua. Funciona por ahora, pero Supabase retira las claves antiguas a finales de 2026: cámbiala por la clave publishable (sb_publishable_…, en Project Settings → API Keys) y vuelve a compilar.',
  unset:
    'BetTracker: no hay VITE_SUPABASE_URL ni VITE_SUPABASE_ANON_KEY, así que este build abrirá la pantalla de configuración. Para publicarlo, rellena antes el .env.',
  devBad: 'BetTracker: el .env tiene un problema (la app también lo muestra):',
  likely: 'BetTracker: el .env probablemente está mal (el build sigue; revísalo):'
}

type Lang = 'en' | 'es'

const fill = (template: string, vars: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (m, name: string) => vars[name] ?? m)

/** The problems as lines of text, for the terminal. */
export function envProblemLines(problems: readonly EnvProblem[], lang: Lang): string[] {
  return problems.map((p) => {
    const { key, vars } = envMessage(p)
    return fill(envStrings[lang][key], vars)
  })
}

/** The terminal's language, from LANG / LC_ALL as Node reads them. */
function terminalLang(): Lang {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('es') ? 'es' : 'en'
  } catch {
    return 'en'
  }
}

/**
 * The Vite plugin. A build stops on a problem, so a broken or unsafe .env
 * never ends up in dist/; `npm run dev` and `preview` only warn, and the app
 * shows the problem on its setup screen. The demo brings its own backend and
 * is not checked.
 */
export function supabaseEnvCheck(lang: Lang = terminalLang()): Plugin {
  const text = lang === 'es' ? buildEs : buildEn
  return {
    name: 'bettracker-supabase-env',
    configResolved(config) {
      if (config.mode === 'demo') return
      const check = checkSupabaseEnv(config.env.VITE_SUPABASE_URL, config.env.VITE_SUPABASE_ANON_KEY)
      const build = config.command === 'build'
      if (check.status === 'bad') {
        const lines = envProblemLines(check.problems, lang).map((l) => `  • ${l}`)
        if (!build) {
          config.logger.warn([text.devBad, ...lines].join('\n'))
          return
        }
        const err = new Error([text.bad, ...lines, text.again].join('\n'))
        // Vite prints the stack; the message is all there is to say.
        err.stack = err.message
        throw err
      }
      if (check.status === 'ok') {
        if (check.warnings.length > 0) config.logger.warn([text.likely, ...envProblemLines(check.warnings, lang).map((l) => `  • ${l}`)].join('\n'))
        if (check.legacyKey) config.logger.warn(text.legacy)
      }
      if (check.status === 'unset' && build) config.logger.warn(text.unset)
    }
  }
}
