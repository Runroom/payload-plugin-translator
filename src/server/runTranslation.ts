import type { Payload } from 'payload'
import { JobCancelledError, NotFound, ValidationError } from 'payload'

import { MarkError } from '../core/lexical.js'
import { ProviderError } from '../provider/types.js'
import type { EntityRef } from './entity.js'
import { defaultLocaleOf, entityOf, localesOf } from './entity.js'
import type { LocaleRun, Outcome, TranslationJobInput } from './localeRun.js'
import { ConcurrentEditError, execute, keyOf } from './localeRun.js'
import type { RecordKey } from './records.js'
import { findRecord, saveRecord } from './records.js'
import type { TranslatorSettings } from './settings.js'

export type RawTranslationJobInput = Omit<
  TranslationJobInput,
  'sourceLocale' | 'targetLocales'
> & {
  sourceLocale?: string | null
  targetLocales: unknown
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// A locale that already failed for good in this same job: the POST sets every record to
// `queued` before the job starts, so a `failed` found here can only come from an earlier
// attempt of this job. Repeating it would spend provider calls to fail the same way.
class PreviousFailure extends Error {
  override readonly name = 'PreviousFailure'
}

// Without drafts Payload validates the whole document on save (a required `label` empty in
// the target, a custom validator): retrying does not fix it.
const isUnrecoverable = (error: unknown): boolean =>
  (error instanceof ProviderError && !error.retryable) ||
  error instanceof MarkError ||
  error instanceof NotFound ||
  error instanceof ValidationError ||
  error instanceof PreviousFailure

const saveFailure = async ({
  payload,
  key,
  message,
  status = 'failed',
}: {
  payload: Payload
  key: RecordKey
  message: string
  status?: 'failed' | 'queued'
}): Promise<void> => {
  try {
    await saveRecord(payload, { key, data: { status, error: message } })
  } catch (err) {
    payload.logger.error({ err, msg: 'Could not save the translation failure' })
  }
}

// With nothing translated, `translatedAt` stays the one of the last real translation:
// moving it would make `onLiveWrite` notify the website again with nothing changed.
const saveDone = async (
  { payload, sourceLocale }: LocaleRun,
  key: RecordKey,
  { hashes, kept, translated }: Outcome,
): Promise<void> => {
  await saveRecord(payload, {
    key,
    data: {
      status: 'done',
      fields: hashes,
      kept,
      error: null,
      sourceLocale,
      ...(translated ? { translatedAt: new Date().toISOString() } : {}),
    },
  })
}

// While a retry is left the record stays `queued`: that keeps the document locked, so a
// new POST does not start another job that would run in parallel with this one.
const recordFailure = async (
  { payload }: LocaleRun,
  key: RecordKey,
  { error, isLastAttempt }: { error: unknown; isLastAttempt: boolean },
): Promise<void> => {
  const willRetry = !isLastAttempt && !isUnrecoverable(error)
  const retryNote = willRetry && error instanceof ConcurrentEditError
  await saveFailure({
    payload,
    key,
    message: retryNote ? `${messageOf(error)}; it will be retried` : messageOf(error),
    status: willRetry ? 'queued' : 'failed',
  })
}

const translateLocale = async ({
  run,
  isLastAttempt,
}: {
  run: LocaleRun
  isLastAttempt: boolean
}): Promise<{ error: unknown } | null> => {
  const { payload, input, targetLocale } = run
  const key = keyOf(input, targetLocale)
  try {
    const record = await findRecord(payload, key)
    if (record?.status === 'failed') {
      return { error: new PreviousFailure(record.error ?? `${targetLocale} failed`) }
    }
    await saveRecord(payload, { key, data: { status: 'running', error: null } })
    await saveDone(run, key, await execute(run, record?.fields ?? {}))
    return null
  } catch (error) {
    await recordFailure(run, key, { error, isLastAttempt })
    return { error }
  }
}

const cancelAll = async ({
  payload,
  input,
  targets,
  message,
}: {
  payload: Payload
  input: RawTranslationJobInput
  targets: string[]
  message: string
}): Promise<never> => {
  for (const targetLocale of targets) {
    await saveFailure({ payload, key: keyOf(input, targetLocale), message })
  }
  throw new JobCancelledError(message)
}

// A job retry goes through every locale again, but the finished ones come out unchanged
// thanks to their fingerprints: retrying repeats neither provider calls nor writes.
const throwFailures = (errors: unknown[]): void => {
  if (errors.length === 0) return
  const retryable = errors.find(error => !isUnrecoverable(error))
  if (retryable !== undefined) throw retryable
  throw new JobCancelledError(errors.map(messageOf).join('; '))
}

const nameOf = ({ entityType, collectionSlug }: EntityRef): string =>
  entityType === 'global' ? `Global ${collectionSlug}` : `Collection ${collectionSlug}`

const requestedLocales = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? [...new Set(raw.filter((item): item is string => typeof item === 'string'))]
    : []

type Prepared = { run: Omit<LocaleRun, 'targetLocale'>; targets: string[] }

const prepare = async ({
  payload,
  input,
  settings,
}: {
  payload: Payload
  input: RawTranslationJobInput
  settings: TranslatorSettings
}): Promise<Prepared> => {
  const name = nameOf(input)
  const requested = requestedLocales(input.targetLocales)
  const config = localesOf(settings, input)
  if (!config) {
    const message = `${name} is not translatable`
    return cancelAll({ payload, input, targets: requested, message })
  }
  // An input without `sourceLocale` is translated from the default locale.
  const sourceLocale = input.sourceLocale ?? defaultLocaleOf(payload)
  const targets = requested.filter(
    locale => config.locales.includes(locale) && locale !== sourceLocale,
  )
  const cancel = (reason: string): Promise<never> =>
    cancelAll({ payload, input, targets, message: reason })
  if (!config.locales.includes(sourceLocale))
    return cancel(`${name} is not translated from ${sourceLocale}`)
  if (targets.length === 0)
    return cancel('The translation requests no valid target locale')
  const entity = entityOf(payload, input)
  if (!entity) return cancel(`${name} does not exist in Payload`)
  const provider = settings.provider
  if (!provider) return cancel('The translator is not configured')
  return {
    run: {
      payload,
      provider,
      settings,
      input: { ...input, sourceLocale, targetLocales: targets },
      entity,
      sourceLocale,
    },
    targets,
  }
}

// Locales run in sequence and inside a single job: each write saves the whole document from
// the latest version, and two in parallel on the same document overwrite each other.
export const runTranslation = async ({
  payload,
  input,
  settings,
  isLastAttempt,
}: {
  payload: Payload
  input: RawTranslationJobInput
  settings: TranslatorSettings
  isLastAttempt: boolean
}): Promise<void> => {
  const { run, targets } = await prepare({ payload, input, settings })
  const errors: unknown[] = []
  for (const targetLocale of targets) {
    const failure = await translateLocale({
      run: { ...run, targetLocale },
      isLastAttempt,
    })
    if (failure) errors.push(failure.error)
  }
  throwFailures(errors)
}
