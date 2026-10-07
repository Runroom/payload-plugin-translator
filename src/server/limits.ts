// These limits are coupled. A job, with all its retries and provider calls, must finish
// well inside the busy window; otherwise its record stops locking the document and a
// second translation can start while the first is still writing.

// How long a `queued` or `running` record locks the document without being updated.
export const BUSY_WINDOW_MS = 15 * 60 * 1000

export const JOB_RETRIES = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 10_000 },
} as const
