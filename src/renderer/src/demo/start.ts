// The demo's entry: only `npm run demo` loads it, from a script tag that
// vite.config.ts adds ahead of main.tsx, so the fake backend is in place
// before lib/supabase.ts picks its client.
import * as extraction from '../../../shared/expenseExtraction'
import { DEMO_PREFIX, DEMO_USER } from './demo'
import { installFakeSupabase, type ExtractionContract } from './fakeSupabase'

// The AI contract the fake server checks scans with (see ExtractionContract).
const contract: ExtractionContract = { parseExtractRequest: extraction.parseExtractRequest, failBody: extraction.failBody, EXTRACT_STATUS: extraction.EXTRACT_STATUS }
;(window as unknown as { __expenseExtraction: ExtractionContract }).__expenseExtraction = contract

// A fresh demo is an up-to-date database with nothing in it.
try {
  localStorage.setItem(`${DEMO_PREFIX}migrated`, '1')
  localStorage.setItem(`${DEMO_PREFIX}migrated-005`, '1')
  localStorage.setItem(`${DEMO_PREFIX}migrated-007`, '1')
  localStorage.setItem(`${DEMO_PREFIX}migrated-008`, '1')
  localStorage.setItem(`${DEMO_PREFIX}migrated-009`, '1')
} catch {
  // storage unavailable — the fake answers as a database missing migrations
}

installFakeSupabase({ prefix: DEMO_PREFIX, user: DEMO_USER, demo: true })
