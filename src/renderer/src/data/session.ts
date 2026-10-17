import { supabase } from '../lib/supabase'
import { isNetworkError, SignedOutError } from './errors'

/**
 * The signed-in user's id, asked for before every request for their rows
 * (see SignedOutError). The session renews itself here when it has run out.
 * When it can't be renewed for want of a connection, that is the network
 * error (the change waits for the connection); for any other reason it is
 * SignedOutError (the change waits for the next sign-in).
 */
export async function signedInUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getSession()
  if (error && isNetworkError(error)) throw error
  const id = data.session?.user?.id
  if (!id) throw new SignedOutError()
  return id
}
