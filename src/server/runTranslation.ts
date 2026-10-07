import type { Payload, TypedUser } from 'payload'
import { JobCancelledError } from 'payload'

import { requesterPermissions } from './docAccess.js'
import type { EntityRef } from './entity.js'
import { defaultLocaleOf, entityOf, localesOf, targetLocalesOf } from './entity.js'
import { ConcurrentEditError, isUnrecoverable, PreviousFailure } from './errors.js'
import type {
  LocaleRun,
  Outcome,
  Previous,
  Requester,
  TranslationJobInput,
} from './localeRun.js'
import { execute } from './localeRun.js'
import type { RecordKey, TranslationRecord } from './records.js'
import { findRecord, recordKeyOf, saveRecord } from './records.js'
import type { TranslatorSettings } from './settings.js'

export type RawTranslationJobInput = Omit<
  TranslationJobInput,
  'sourceLocale' | 'targetLocales' | 'requester'
> & {
  sourceLocale?: string | null
  targetLocales: unknown
  requester?: unknown
}

export const MISSING_REQUESTER = 'The user who requested the translation no longer exists'

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
  { payload, sourceLocale }: Pick<LocaleRun, 'payload' | 'sourceLocale'>,
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
  { payload }: Pick<LocaleRun, 'payload'>,
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

// The requester's access is checked again on every attempt, in the locales the job reads
// and writes, so a user who lost access since queueing gets nothing written.
const permissionsOf = (
  { payload, input, sourceLocale, targetLocale }: Omit<LocaleRun, 'permissions'>,
  user: TypedUser,
): ReturnType<typeof requesterPermissions> =>
  requesterPermissions({ payload, user, ref: input, sourceLocale, targetLocale })

const translateLocale = async ({
  run,
  user,
  isLastAttempt,
  jobCreatedAt,
}: {
  run: Omit<LocaleRun, 'permissions'>
  user: TypedUser
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
    const permissions = await permissionsOf(run, user)
    await saveRecord(payload, { key, data: { status: 'running', error: null } })
    const outcome = await execute({ ...run, permissions }, previousOf(payload, record))
    await saveDone(run, key, outcome)
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

const requesterOf = (raw: unknown): Requester | null => {
  const value = raw as { collection?: unknown; id?: unknown } | null
  if (!value || typeof value.collection !== 'string') return null
  if (typeof value.id !== 'string' && typeof value.id !== 'number') return null
  return { collection: value.collection, id: String(value.id) }
}

// The job runs outside the request that queued it, so the requester is loaded again on
// every attempt; a user deleted in the meantime can no longer translate anything.
const loadRequester = async (
  payload: Payload,
  requester: Requester | null,
): Promise<TypedUser | null> => {
  if (!requester) return null
  const user = (await payload.findByID({
    collection: requester.collection as never,
    id: requester.id,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
  })) as unknown as Record<string, unknown> | null
  return user ? ({ ...user, collection: requester.collection } as TypedUser) : null
}

type Prepared = {
  run: Omit<LocaleRun, 'targetLocale' | 'permissions'>
  user: TypedUser
  targets: string[]
}

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
  const provider = settings.provider
  if (!provider) return cancel('The translator is not configured')
  const requester = requesterOf(input.requester)
  const user = await loadRequester(payload, requester)
  if (!requester || !user) return cancel(MISSING_REQUESTER)
  const entity = entityOf(payload, input, { user })
  if (!entity) return cancel(`${name} does not exist in Payload`)
  return {
    run: {
      payload,
      provider,
      settings,
      input: { ...input, sourceLocale, targetLocales: targets, requester },
      entity,
      sourceLocale,
    },
    user,
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
  const { run, user, targets } = await prepare({ payload, input, settings })
  const errors: unknown[] = []
  for (const targetLocale of targets) {
    const failure = await translateLocale({
      run: { ...run, targetLocale },
      user,
      isLastAttempt,
      jobCreatedAt,
    })
    if (failure) errors.push(failure.error)
  }
  throwFailures(errors)
}
