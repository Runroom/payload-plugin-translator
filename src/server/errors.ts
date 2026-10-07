import { NotFound, ValidationError } from 'payload'

import { MarkError } from '../core/lexical.js'
import { ProviderError } from '../provider/types.js'

export class ConcurrentEditError extends Error {
  override readonly name = 'ConcurrentEditError'
}

// A locale that already failed for good in this same job: the POST sets every record to
// `queued` before the job starts, so a `failed` found here can only come from an earlier
// attempt of this job. Repeating it would spend provider calls to fail the same way.
export class PreviousFailure extends Error {
  override readonly name = 'PreviousFailure'
}

// Without drafts Payload validates the whole document on save (a required `label` empty in
// the target, a custom validator): retrying does not fix it.
export const isUnrecoverable = (error: unknown): boolean =>
  (error instanceof ProviderError && !error.retryable) ||
  error instanceof MarkError ||
  error instanceof NotFound ||
  error instanceof ValidationError ||
  error instanceof PreviousFailure
