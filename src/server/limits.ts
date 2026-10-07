// These limits are coupled: a job (all its retries and provider calls) must finish well
// inside the busy window, otherwise the record stops locking the document and a second
// translation can start while the first one is still writing.

// An expired queued/running record stops locking the document.
export const BUSY_WINDOW_MS = 15 * 60 * 1000

export const JOB_RETRIES = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 10_000 },
} as const
