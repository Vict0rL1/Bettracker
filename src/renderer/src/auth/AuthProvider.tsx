import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { AUTH_STORAGE_KEY, supabase } from '../lib/supabase'
import { clearUserData, loadLastUser, markSignedIn, saveLastUser, signedOutElsewhere, type OfflineUser } from '../data/offline'
import { authFailure } from './authErrors'

interface AuthState {
  session: Session | null
  loading: boolean
  email: string | null
  userId: string | null
  /** Cached identity from the last sign-in on this device — lets the app open
   *  with local data when a session can't be refreshed (e.g. fully offline). */
  offlineUser: OfflineUser | null
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string) => Promise<{ needsConfirmation: boolean }>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  // Who signed in on this device last, for offline boots (see saveLastUser).
  const [lastUser, setLastUser] = useState<OfflineUser | null>(loadLastUser)

  useEffect(() => {
    let active = true
    // Signed in (again): this user's data is stored once more, before
    // anything renders for them (see clearUserData).
    const take = (next: Session | null): void => {
      if (next?.user) markSignedIn(next.user.id)
      setSession(next)
      setLoading(false)
    }
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (active) take(data.session)
      })
      .catch(() => active && setLoading(false))

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => take(next))
    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [])

  // Remember who is signed in on this device, for offline boots.
  useEffect(() => {
    if (!session?.user) return
    const user = { id: session.user.id, email: session.user.email ?? null }
    saveLastUser(user)
    setLastUser((was) => (was?.id === user.id && was.email === user.email ? was : user))
  }, [session])

  // Signed out in another window, which cleared this device's copy of the
  // account (see clearUserData): this window leaves it too. Kept, it would show
  // data no longer on the device, and what it changed would be stored nowhere.
  // Supabase tells other windows of a sign-out, but not always: not of one made
  // offline with an expired token, nor does the demo.
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      const gone = signedOutElsewhere(e)
      if (!gone) return
      setSession((s) => (s?.user?.id === gone ? null : s))
      setLastUser((u) => (u?.id === gone ? null : u))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // Keep the access token fresh across app open/close cycles. An installed app
  // gets backgrounded a lot; refreshing while it's in the foreground (and
  // pausing when hidden) keeps you signed in without re-entering credentials.
  useEffect(() => {
    const manage = (): void => {
      if (document.visibilityState === 'visible') void supabase.auth.startAutoRefresh?.()
      else void supabase.auth.stopAutoRefresh?.()
    }
    manage()
    document.addEventListener('visibilitychange', manage)
    return () => document.removeEventListener('visibilitychange', manage)
  }, [])

  const value = useMemo<AuthState>(
    () => ({
      session,
      loading,
      email: session?.user?.email ?? null,
      userId: session?.user?.id ?? null,
      offlineUser: session ? null : lastUser,
      async signIn(email, password) {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw authFailure(error)
      },
      async signUp(email, password) {
        // The confirmation email links back to this address when the project
        // allows it (Authentication → URL Configuration → Redirect URLs);
        // otherwise Supabase uses its Site URL. Not from a desktop file:// page.
        const here = /^https?:$/.test(window.location.protocol) ? window.location.origin : undefined
        const { data, error } = await supabase.auth.signUp({ email, password, options: here ? { emailRedirectTo: here } : undefined })
        if (error) throw authFailure(error)
        // When email confirmation is on, no session comes back until confirmed.
        return { needsConfirmation: !data.session }
      },
      async signOut() {
        // Signing out removes this device's copy of the data (cache + queued
        // changes) — anything already synced stays safe in the cloud.
        const uid = session?.user?.id ?? lastUser?.id
        if (uid) clearUserData(uid)
        setLastUser(null)
        try {
          await supabase.auth.signOut()
        } catch {
          // Offline sign-out: the server call failed, clear locally anyway.
        }
        try {
          localStorage.removeItem(AUTH_STORAGE_KEY)
        } catch {
          // storage unavailable — nothing more to clear
        }
        setSession(null)
      }
    }),
    [session, loading, lastUser]
  )

  return <AuthContext value={value}>{children}</AuthContext>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
