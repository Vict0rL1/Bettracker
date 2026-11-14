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
