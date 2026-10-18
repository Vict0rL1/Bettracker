import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { checkSupabaseEnv, type EnvProblem } from '../../../shared/supabaseEnv'
import { timeoutFetch } from './timeoutFetch'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

interface TestGlobal {
  __supabaseMock?: SupabaseClient
}

// Test/demo seam: the e2e harness and `npm run demo` install a fake client on
// window before the app boots, so the app runs without a live backend.
const injected = (globalThis as TestGlobal).__supabaseMock

// What this copy was built with, checked (the build checks it too, and stops
// on a problem; `npm run dev` only warns, so the setup screen says it here).
// A URL supabase-js refuses would otherwise throw below and leave the page blank.
const env = injected ? null : checkSupabaseEnv(url, anonKey)

/** What is wrong with VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY, if anything. */
export const envProblems: readonly EnvProblem[] = env?.status === 'bad' ? env.problems : []

/** True when the app has a backend to talk to: a Supabase project, or the fake one. */
export const isConfigured = Boolean(injected) || env?.status === 'ok'

/** Where supabase-js keeps the session on this device. */
export const AUTH_STORAGE_KEY = 'bettracker-auth'

/**
 * True while this device holds a session, even one that ran out and can't be
 * renewed for want of a connection. False once Supabase ended it (a sign-out
 * on another device): then only a new sign-in brings it back.
 */
export function hasStoredSession(): boolean {
  try {
    return localStorage.getItem(AUTH_STORAGE_KEY) !== null
  } catch {
    return true
  }
}

/** How long a request may go without an answer before it counts as unreachable. */
const REQUEST_TIMEOUT_MS = 30_000

function makeClient(): SupabaseClient {
  if (injected) return injected

  if (!isConfigured) {
    // Defer the hard failure to first use so the app can still render a
    // helpful "not configured" screen instead of a blank crash.
    return new Proxy({} as SupabaseClient, {
      get() {
        throw new Error('Supabase is not configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY')
      }
    })
  }

  // As checked: a stray newline at the end of the key would otherwise reach
  // the realtime connection's URL and break live sync.
  return createClient((url as string).trim(), (anonKey as string).trim(), {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storageKey: AUTH_STORAGE_KEY
    },
    // A request with no answer after this long is given up (see timeoutFetch).
    global: { fetch: timeoutFetch(REQUEST_TIMEOUT_MS) }
  })
}

export const supabase: SupabaseClient = makeClient()
