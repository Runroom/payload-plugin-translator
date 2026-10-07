import { NotFound, ValidationError } from 'payload'

import { MarkError } from '../core/lexical.js'
import { ProviderError } from '../provider/types.js'

export class ConcurrentEditError extends Error {
  override readonly name = 'ConcurrentEditError'
}

// A locale that already failed for good earlier in this job. The POST sets every record to
// `queued` before the job starts, so a `failed` record can only come from an earlier
// attempt of the same job, and repeating it would spend provider calls to fail again.
export class PreviousFailure extends Error {
  override readonly name = 'PreviousFailure'
}

// Without drafts Payload validates the whole document on save, so a `ValidationError` (an
// empty required `label` in the target, a custom validator) will not go away on retry.
export const isUnrecoverable = (error: unknown): boolean =>
  (error instanceof ProviderError && !error.retryable) ||
  error instanceof MarkError ||
  error instanceof NotFound ||
  error instanceof ValidationError ||
  error instanceof PreviousFailure
