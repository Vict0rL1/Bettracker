import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

/** True when the app has been given a Supabase project to talk to. */
export const isConfigured = Boolean(url && anonKey)

interface TestGlobal {
  __supabaseMock?: SupabaseClient
}

function makeClient(): SupabaseClient {
  // Test/preview seam: a harness can inject a mock client on window before the
  // app boots, so UI flows can be exercised without a live backend.
  const injected = (globalThis as TestGlobal).__supabaseMock
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
