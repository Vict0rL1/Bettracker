/**
 * One run of `fn` at a time: a call while one is running asks for one more
 * run after it (however many calls came meanwhile), and resolves when that
 * one is through. A run whose `still` says no (the user changed) is skipped.
 */
export function oneAtATime(fn: () => Promise<void>, still: () => boolean = () => true): () => Promise<void> {
  let running: Promise<void> | null = null
  let again: Promise<void> | null = null
  const run = async (): Promise<void> => {
    try {
      if (still()) await fn()
    } finally {
      running = null
    }
  }
  return () => {
    if (!running) {
      running = run()
      return running
    }
    // One more after the run going now: every call meanwhile shares it.
    again ??= running.then(() => {
      again = null
      running = run()
      return running
    })
    return again
  }
}
