import type { Payload } from 'payload'
import { JobCancelledError } from 'payload'

import type { EntityRef } from './entity.js'
import { defaultLocaleOf, entityOf, localesOf, targetLocalesOf } from './entity.js'
import { ConcurrentEditError, isUnrecoverable, PreviousFailure } from './errors.js'
import type { LocaleRun, Outcome, Previous, TranslationJobInput } from './localeRun.js'
import { execute } from './localeRun.js'
import type { RecordKey, TranslationRecord } from './records.js'
import { findRecord, recordKeyOf, saveRecord } from './records.js'
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

// When nothing was translated, `translatedAt` keeps the date of the last real translation.
// Updating it would make `onLiveWrite` notify the website again with nothing changed.
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

// While a retry is pending the record stays `queued`. That keeps the document locked, so a
// new POST cannot start another job that would run in parallel with this one.
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

// A record without `sourceLocale` was translated from the default locale.
const previousOf = (payload: Payload, record: TranslationRecord | null): Previous => ({
  fields: record?.fields ?? {},
  sourceLocale: record?.sourceLocale ?? defaultLocaleOf(payload),
})

const translateLocale = async ({
  run,
  isLastAttempt,
  jobCreatedAt,
}: {
  run: LocaleRun
  isLastAttempt: boolean
  jobCreatedAt?: string | Date
}): Promise<{ error: unknown } | null> => {
  const { payload, input, targetLocale } = run
  const key = recordKeyOf(input, targetLocale)
  try {
    const record = await findRecord(payload, key)
    if (
      record?.status === 'failed' &&
      (!jobCreatedAt ||
        !record.updatedAt ||
        Date.parse(String(record.updatedAt)) >= Date.parse(String(jobCreatedAt)))
    ) {
      return { error: new PreviousFailure(record.error ?? `${targetLocale} failed`) }
    }
    await saveRecord(payload, { key, data: { status: 'running', error: null } })
    await saveDone(run, key, await execute(run, previousOf(payload, record)))
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
    await saveFailure({ payload, key: recordKeyOf(input, targetLocale), message })
  }
  throw new JobCancelledError(message)
}

// A job retry goes through every locale again, but the finished ones come out unchanged
// thanks to their fingerprints, so no provider call or write is repeated.
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
  const sourceLocale = input.sourceLocale ?? defaultLocaleOf(payload)
  const targets = targetLocalesOf({ locales: config.locales, sourceLocale, requested })
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

// Locales run in sequence inside a single job because each write saves the whole document
// from the latest version, so two parallel writes to the same document overwrite each
// other.
export const runTranslation = async ({
  payload,
  input,
  settings,
  isLastAttempt,
  jobCreatedAt,
}: {
  payload: Payload
  input: RawTranslationJobInput
  settings: TranslatorSettings
  isLastAttempt: boolean
  jobCreatedAt?: string | Date
}): Promise<void> => {
  const { run, targets } = await prepare({ payload, input, settings })
  const errors: unknown[] = []
  for (const targetLocale of targets) {
    const failure = await translateLocale({
      run: { ...run, targetLocale },
      isLastAttempt,
      jobCreatedAt,
    })
    if (failure) errors.push(failure.error)
  }
  throwFailures(errors)
}
