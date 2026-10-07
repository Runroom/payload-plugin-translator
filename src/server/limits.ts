// These limits are coupled. The document is locked by a row in `translation-locks` whose
// `updatedAt` is the heartbeat: the job refreshes it at the start of every attempt, before
// each record write, after every provider batch and right before each write. What must
// fit inside the busy window is the gap between two refreshes, in practice one provider
// batch call with its retries; otherwise the lock expires, a new request takes it over
// and the running job is cancelled as superseded at its next refresh. The job's retry
// backoff also runs inside the window, since the lock is kept while a retry is pending.

// How long the lock, and a `queued` or `running` record, stay live without a heartbeat.
export const BUSY_WINDOW_MS = 15 * 60 * 1000

export const JOB_RETRIES = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 10_000 },
} as const
