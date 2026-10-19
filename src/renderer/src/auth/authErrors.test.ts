import { describe, expect, it } from 'vitest'
import { authErrorKey, authFailure, linkError } from './authErrors'

describe('authErrorKey', () => {
  it.each([
    // What the API gateway answers before Auth sees the request: no code.
    ['a key from another project', { message: 'Invalid API key', status: 401 }, 'login.err.key'],
    ['a disabled legacy key', { message: 'Legacy API keys are disabled', status: 401 }, 'login.err.key'],
    ['a secret key in a browser', { message: 'Forbidden use of secret API key in browser', status: 401 }, 'login.err.key'],
    ['no connection (supabase-js)', { message: 'Failed to fetch', status: 0 }, 'login.err.network'],
    ['no connection (Safari)', { message: 'Load failed' }, 'login.err.network'],
    ['wrong password', { message: 'Invalid login credentials', code: 'invalid_credentials', status: 400 }, 'login.err.credentials'],
    ['wrong password, older server', { message: 'Invalid login credentials', status: 400 }, 'login.err.credentials'],
    ['not confirmed', { message: 'Email not confirmed', code: 'email_not_confirmed', status: 400 }, 'login.err.unconfirmed'],
    ['not confirmed, older server', { message: 'Email not confirmed', status: 400 }, 'login.err.unconfirmed'],
    ['signed up already', { message: 'User already registered', code: 'user_already_exists', status: 422 }, 'login.err.exists'],
    ['signed up already, older server', { message: 'User already registered', status: 422 }, 'login.err.exists'],
    ['too many emails', { message: 'email rate limit exceeded', code: 'over_email_send_rate_limit', status: 429 }, 'login.err.rate'],
    ['too many requests', { message: 'Request rate limit reached', status: 429 }, 'login.err.rate'],
    ['sign-ups off', { message: 'Signups not allowed for this instance', code: 'signup_disabled', status: 422 }, 'login.err.signupOff'],
    ['an address it refuses', { message: 'Email address "a@b.c" is invalid', code: 'email_address_invalid', status: 400 }, 'login.err.email'],
    ['an email link expired or already used', { message: 'Email link is invalid or has expired', code: 'otp_expired' }, 'login.err.link']
  ] as const)('%s', (_name, failure, key) => {
    expect(authErrorKey(failure)).toBe(key)
  })

  // supabase-js turns a 5xx into a message of "{}": shown as it came, it said nothing.
  it('says a server failure in words', () => {
    expect(authErrorKey({ message: '{}', status: 500 })).toBe('login.err.server')
    expect(authErrorKey({ message: '{}', status: 503 })).toBe('login.err.server')
  })

  it('leaves anything else in Supabase’s own words', () => {
    expect(authErrorKey({ message: 'Password should contain at least one character of each: abc', code: 'weak_password', status: 422 })).toBeNull()
    expect(authErrorKey({ message: 'Signups not allowed for otp', status: 422 })).toBeNull()
  })
})

describe('authFailure', () => {
  it('is an Error that keeps the code and status', () => {
    const e = authFailure({ message: 'Email not confirmed', code: 'email_not_confirmed', status: 400 })
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toBe('Email not confirmed')
    expect(authErrorKey(e)).toBe('login.err.unconfirmed')
  })
})

describe('linkError', () => {
  it('reads the error Supabase puts in the address after an email link that didn’t work', () => {
    const hash = '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'
    expect(linkError(hash)).toEqual({ message: 'Email link is invalid or has expired', code: 'otp_expired' })
    expect(authErrorKey(linkError(hash)!)).toBe('login.err.link')
  })

  it('keeps an error it doesn’t know, in Supabase’s words', () => {
    expect(linkError('#error=server_error&error_description=Unable+to+exchange+external+code')).toEqual({
      message: 'Unable to exchange external code',
      code: undefined
    })
  })

  it('is nothing for any other address: none, a session coming in, a plain anchor', () => {
    expect(linkError('')).toBeNull()
    expect(linkError('#access_token=a&refresh_token=b&type=signup')).toBeNull()
    expect(linkError('#top')).toBeNull()
  })
})
