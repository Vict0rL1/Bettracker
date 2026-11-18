/**
 * One run of `fn` at a time: a call while one is running asks for one more
 * run after it (however many calls came meanwhile), and resolves when that
 * one is through. A run whose `still` says no (the user changed) is skipped.
 * A run that fails fails only its own callers: the one after it still runs.
 */
export function oneAtATime(fn: () => Promise<void>, still: () => boolean = () => true): () => Promise<void> {
  let running: Promise<void> | null = null
  let again: Promise<void> | null = null
  let runs = 0
  const start = (): Promise<void> => {
    const mine = ++runs
    running = (async () => {
      try {
        if (still()) await fn()
      } finally {
        // Only this run's: one started after it is still going.
        if (runs === mine) running = null
      }
    })()
    return running
  }
  return () => {
    if (!running) return start()
    // One more after the run going now (however it ends): every call meanwhile
    // shares it; one started in between (a call after this run ended) is it.
    again ??= running
      .catch(() => undefined)
      .then(() => {
        again = null
        return running ?? start()
      })
    return again
  }
}

/**
 * The drains of one queue, one at a time per user, never dropping a call. A
 * call while a drain for that user is out may come too late for it: the drain
 * may already have read the queue, or met the connection as it was before a
 * reconnect or a resume. So `start` (false while one is out) remembers the
 * call, and `end` says whether one more drain is due after this one, however
 * many calls came meanwhile. A drain still out for a user who has signed out
 * never holds up the next user's.
 */
export function drainTurns<K>(): { start(key: K): boolean; end(key: K): boolean } {
  let current: K | null = null
  let again: K | null = null
  return {
    start(key) {
      if (current === key) {
        again = key
        return false
      }
      current = key
      // Whatever was asked for before now, this drain sees.
      if (again === key) again = null
      return true
    },
    end(key) {
      if (current === key) current = null
      if (again !== key) return false
      again = null
      return true
    }
  }
}
