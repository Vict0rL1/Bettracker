import { supabase } from '../lib/supabase'
import { isNetworkError, SignedOutError } from './errors'

/**
 * The signed-in user's id, asked for before every request for their rows
 * (see SignedOutError). The session renews itself here when it has run out.
 * When it can't be renewed for want of a connection, that is the network
 * error (the change waits for the connection); for any other reason it is
 * SignedOutError (the change waits for the next sign-in).
 *
 * `asUser` is the user the request is for (whose queue, whose screen): a
 * session of anyone else counts as none, so a sync started for one account
 * never reads or writes as the next one to sign in on this device.
 */
export async function signedInUserId(asUser?: string): Promise<string> {
  const { data, error } = await supabase.auth.getSession()
  if (error && isNetworkError(error)) throw error
  const id = data.session?.user?.id
  if (!id || (asUser !== undefined && id !== asUser)) throw new SignedOutError()
  return id
}
