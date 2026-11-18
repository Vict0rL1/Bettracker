#!/usr/bin/env node
// Live contract check of the exchange-rate service the app converts expenses
// with (Frankfurter, the European Central Bank's reference rates).
//
// The unit and e2e suites never touch the network: they answer for the
// service themselves. This script is the other half: it calls the REAL
// service and reads its answers with the SAME code the app uses
// (src/renderer/src/lib/fx.ts, compiled here from its source), so a change in
// the service's answers, its dates or its CORS headers is noticed here and
// not by a user in front of an empty rate box.
//
//   npm run check:rates          (after npm ci: it uses the typescript package)
//
// It asks for USD→CAD: the latest rate, a past weekday, and a past Saturday
// (which must answer with the Friday before). For each it prints the request
// and the answer, and checks: HTTP 200, a JSON body the app's parser accepts,
// the day the rate is of, and `access-control-allow-origin` for a browser
// origin. It also notes how the service answers for a currency it doesn't
// have (the app reads any 4xx as "no rates for this pair").
//
// Exit code: 0 everything as the app expects; 1 the service answered
// something the app would not read as expected; 2 the service could not be
// reached (nothing was checked); 3 this script could not start.
//
// Not part of the main CI on purpose: the main CI must never depend on a
// third party. See .github/workflows/rates-contract.yml.

import { readFile } from 'node:fs/promises'

const FX_FILE = new URL('../src/renderer/src/lib/fx.ts', import.meta.url)
/** An origin like the one a browser sends from the deployed app. */
const ORIGIN = 'https://bettracker.example'
const TIMEOUT_MS = 20_000
const FROM = 'USD'
const TO = 'CAD'
/** A Thursday and the Saturday after it, both ordinary days for the bank (the Friday between them too). */
const WEEKDAY = '2025-11-13'
const SATURDAY = '2025-11-15'
const FRIDAY_BEFORE = '2025-11-14'

const say = (line = '') => process.stdout.write(`${line}\n`)

/** The app's own module, compiled from its TypeScript source (it has no imports: lib/fx.test.ts keeps it so). */
async function loadFx() {
  let ts
  try {
    ts = (await import('typescript')).default
  } catch {
    throw new SetupError('the "typescript" package is not installed: run `npm ci` first')
  }
  let source
  try {
    source = await readFile(FX_FILE, 'utf8')
  } catch {
    throw new SetupError('src/renderer/src/lib/fx.ts could not be read: run this from a checkout of the repository')
  }
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
  const fx = await import(`data:text/javascript;base64,${Buffer.from(outputText, 'utf8').toString('base64')}`)
  for (const name of ['rateUrl', 'parseRateBody', 'FX_ORIGIN']) {
    if (!(name in fx)) throw new SetupError(`src/renderer/src/lib/fx.ts no longer exports ${name}: update scripts/check-rates.mjs with it`)
  }
  return fx
}

class SetupError extends Error {}
class UnreachableError extends Error {}

/** Why a request got no answer, in a few words (never a stack trace). */
function why(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `no answer within ${TIMEOUT_MS / 1000} s`
  const cause = err?.cause
  const code = cause?.code ?? cause?.errors?.[0]?.code
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `its name could not be resolved (${code}): no DNS, or no network`
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `the connection failed (${code})`
  if (typeof code === 'string') return `the request failed (${code})`
  const text = typeof cause?.message === 'string' ? cause.message : typeof err?.message === 'string' ? err.message : String(err)
  return `the request failed (${text.split('\n')[0].slice(0, 200)})`
}

/** One GET, as a browser page of the app would send it (an Origin, nothing else of note). */
async function get(url) {
  let res
  try {
    res = await fetch(url, { method: 'GET', headers: { origin: ORIGIN }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (err) {
    throw new UnreachableError(why(err))
  }
  let text
  try {
    text = await res.text()
  } catch (err) {
    throw new UnreachableError(`the answer stopped halfway: ${why(err)}`)
  }
  return { status: res.status, type: res.headers.get('content-type') ?? '', cors: res.headers.get('access-control-allow-origin'), text }
}

const short = (text) => (text.length > 600 ? `${text.slice(0, 600)}… (${text.length} characters)` : text)

async function main() {
  const fx = await loadFx()
  const today = new Date().toISOString().slice(0, 10)
  const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)

  /** Each request, and what the day of its rate must be. */
  const cases = [
    {
      name: 'the latest rate (what the app asks for today and for a later day)',
      url: fx.rateUrl(FROM, TO, today, today),
      day: (asOf) => {
        const age = daysBetween(asOf, today)
        // The newest business day: today, or up to a long weekend back (and "tomorrow" seen from a clock west of the bank's).
        return age >= -1 && age <= 7 ? null : `the latest rate is of ${asOf}, ${age} days from today (${today}): expected the last business day`
      }
    },
    {
      name: `a past weekday (${WEEKDAY}, a Thursday)`,
      url: fx.rateUrl(FROM, TO, WEEKDAY, today),
      day: (asOf) => (asOf === WEEKDAY ? null : `the rate is of ${asOf}: expected ${WEEKDAY} itself`)
    },
    {
      name: `a past Saturday (${SATURDAY}): the business day before it`,
      url: fx.rateUrl(FROM, TO, SATURDAY, today),
      day: (asOf) => (asOf === FRIDAY_BEFORE ? null : `the rate is of ${asOf}: expected the Friday before, ${FRIDAY_BEFORE}`)
    }
  ]

  say(`Exchange-rate service: ${fx.FX_ORIGIN}`)
  say(`Parser: src/renderer/src/lib/fx.ts (the app's own), pair ${FROM}→${TO}, Origin: ${ORIGIN}`)
  const problems = []
  let reached = 0
  for (const c of cases) {
    say()
    say(`• ${c.name}`)
    if (typeof c.url !== 'string') {
      problems.push(`${c.name}: the app builds no request for it`)
      say('  ✗ the app builds no request for it')
      continue
    }
    say(`  GET ${c.url}`)
    let answer
    try {
      answer = await get(c.url)
    } catch (err) {
      if (!(err instanceof UnreachableError)) throw err
      // Nothing came back at all: with no answer so far, the service is out of reach from here.
      if (reached === 0) throw err
      problems.push(`${c.name}: ${err.message}`)
      say(`  ✗ no answer: ${err.message}`)
      continue
    }
    reached++
    say(`  HTTP ${answer.status} · content-type: ${answer.type || '(none)'} · access-control-allow-origin: ${answer.cors ?? '(none)'}`)
    say(`  ${short(answer.text)}`)
    const found = []
    let body
    if (answer.status !== 200) {
      // Not the service's answer to this request (or not a good one): nothing else of it is worth judging.
      found.push(`HTTP ${answer.status}: expected 200${answer.status === 403 || answer.status === 407 ? ' (a proxy or a firewall in between?)' : ''}`)
    } else {
      if (answer.cors !== '*' && answer.cors !== ORIGIN) found.push(`access-control-allow-origin is ${answer.cors ?? 'missing'}: a browser would block the app's request (expected * or the Origin sent)`)
      try {
        body = JSON.parse(answer.text)
      } catch {
        found.push('the body is not JSON')
      }
    }
    if (body !== undefined) {
      const parsed = fx.parseRateBody(body, FROM, TO)
      if (parsed === null) found.push(`the app's parser does not accept this body (expected {"amount":1.0,"base":"${FROM}","date":"YYYY-MM-DD","rates":{"${TO}":<number>}})`)
      else {
        say(`  the app reads: 1 ${FROM} = ${parsed.rate} ${TO}, rate of ${parsed.asOf}`)
        const wrongDay = c.day(parsed.asOf)
        if (wrongDay) found.push(wrongDay)
      }
    }
    for (const f of found) {
      problems.push(`${c.name}: ${f}`)
      say(`  ✗ ${f}`)
    }
    if (found.length === 0) say('  ✓ as the app expects')
  }

  // How the service says "I have no rates for this currency": the app reads any 4xx as that (and then asks the user
  // for the rate). Anything else would only make the hint less exact, so this is a note and never fails the check.
  say()
  say('• a currency the service has no rates for (COP), for the record')
  const odd = fx.rateUrl(FROM, 'COP', today, today)
  say(`  GET ${odd}`)
  try {
    const answer = await get(odd)
    say(`  HTTP ${answer.status} · ${short(answer.text)}`)
    if (answer.status >= 400 && answer.status <= 499) say('  ✓ a 4xx: the app says the pair has no rates and asks for the rate')
    else if (answer.status === 200 && fx.parseRateBody(JSON.parse(answer.text), FROM, 'COP') !== null) say('  note: the service has rates for COP now; the app will use them')
    else say('  note: not a 4xx: the app would say the rate is unavailable (and still ask for it) instead of "no rates for this pair"')
  } catch (err) {
    say(`  note: ${err instanceof UnreachableError ? err.message : 'the answer could not be read'}`)
  }

  say()
  if (problems.length > 0) {
    say(`FAILED: ${problems.length} thing${problems.length === 1 ? '' : 's'} the app would not read as expected:`)
    for (const p of problems) say(`  - ${p}`)
    return 1
  }
  say('OK: the service answers as the app expects.')
  return 0
}

try {
  process.exitCode = await main()
} catch (err) {
  if (err instanceof UnreachableError) {
    say()
    say(`Could not reach the service (api.frankfurter.dev): ${err.message}.`)
    say('Nothing was checked. Run this again from a machine with internet access (or the "Rates contract" workflow on GitHub).')
    process.exitCode = 2
  } else if (err instanceof SetupError) {
    say(`check-rates could not start: ${err.message}.`)
    process.exitCode = 3
  } else {
    // Never a stack trace: one line saying what went wrong.
    say(`check-rates stopped on an unexpected error: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
    process.exitCode = 3
  }
}
