import { isNetworkError } from '../data/errors'
import type { StringKey } from '../lib/strings'

/**
 * A failed sign-in or sign-up as Supabase Auth reports it: its words (always
 * English), and the code and HTTP status when it gives them.
 */
export interface AuthFailure {
  message: string
  code?: string
  status?: number
}

/** The error AuthProvider throws: Supabase's, with its code and status kept for authErrorKey. */
export function authFailure(e: AuthFailure): Error & AuthFailure {
  return Object.assign(new Error(e.message), { code: e.code, status: e.status })
}

/**
 * The string to show for a failed sign-in or sign-up, or null to show
 * Supabase's own words. The code decides when there is one; servers that
 * send none are read by their message.
 */
export function authErrorKey(e: AuthFailure): StringKey | null {
  // The API gateway, before Auth: a key from another project, a disabled
  // legacy key, a secret key in a browser. It sends no code.
  if (/\bapi keys?\b/i.test(e.message)) return 'login.err.key'
  if (e.status === 0 || isNetworkError(e.message)) return 'login.err.network'
  switch (e.code) {
    case 'invalid_credentials':
      return 'login.err.credentials'
    case 'email_not_confirmed':
      return 'login.err.unconfirmed'
    case 'user_already_exists':
    case 'email_exists':
      return 'login.err.exists'
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
      return 'login.err.rate'
    case 'signup_disabled':
      return 'login.err.signupOff'
    case 'email_address_invalid':
      return 'login.err.email'
    case 'otp_expired':
      return 'login.err.link'
  }
  if (/invalid login credentials/i.test(e.message)) return 'login.err.credentials'
  if (/email not confirmed/i.test(e.message)) return 'login.err.unconfirmed'
  if (/already registered/i.test(e.message)) return 'login.err.exists'
  if (e.status === 429 || /rate limit/i.test(e.message)) return 'login.err.rate'
  return null
}

/**
 * What Supabase puts in the address when an email link didn't work — most
 * often a confirmation link that expired, or one already opened (some mail
 * scanners open links before you do). supabase-js reads it and leaves it
 * there; the sign-in screen says it in words.
 */
export function linkError(hash: string): AuthFailure | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const message = params.get('error_description')
  if (!message) return null
  return { message, code: params.get('error_code') ?? undefined }
}
