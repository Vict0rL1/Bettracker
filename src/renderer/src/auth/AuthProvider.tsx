import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { clearUserData, loadLastUser, saveLastUser, type OfflineUser } from '../data/offline'

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

  useEffect(() => {
    let active = true
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (active) {
          setSession(data.session)
          setLoading(false)
        }
      })
      .catch(() => active && setLoading(false))

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
      setLoading(false)
    })
    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [])

  // Remember who is signed in on this device, for offline boots.
  useEffect(() => {
    if (session?.user) saveLastUser({ id: session.user.id, email: session.user.email ?? null })
  }, [session])

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
      offlineUser: session ? null : loadLastUser(),
      async signIn(email, password) {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw new Error(error.message)
      },
      async signUp(email, password) {
        const { data, error } = await supabase.auth.signUp({ email, password })
        if (error) throw new Error(error.message)
        // When email confirmation is on, no session comes back until confirmed.
        return { needsConfirmation: !data.session }
      },
      async signOut() {
        // Signing out removes this device's copy of the data (cache + queued
        // changes) — anything already synced stays safe in the cloud.
        const uid = session?.user?.id ?? loadLastUser()?.id
        if (uid) clearUserData(uid)
        try {
          await supabase.auth.signOut()
        } catch {
          // Offline sign-out: the server call failed, clear locally anyway.
        }
        try {
          localStorage.removeItem('bettracker-auth')
        } catch {
          // storage unavailable — nothing more to clear
        }
        setSession(null)
      }
    }),
    [session, loading]
  )

  return <AuthContext value={value}>{children}</AuthContext>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
