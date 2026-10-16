import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

interface TestGlobal {
  __supabaseMock?: SupabaseClient
}

// Test/demo seam: the e2e harness and `npm run demo` install a fake client on
// window before the app boots, so the app runs without a live backend.
const injected = (globalThis as TestGlobal).__supabaseMock

/** True when the app has a backend to talk to: a Supabase project, or the fake one. */
export const isConfigured = Boolean(injected) || Boolean(url && anonKey)

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

  return createClient(url as string, anonKey as string, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storageKey: 'bettracker-auth'
    }
  })
}

export const supabase: SupabaseClient = makeClient()
