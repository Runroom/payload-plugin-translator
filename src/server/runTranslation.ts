import type { Payload, TypedUser } from 'payload'
import { JobCancelledError } from 'payload'

import { requesterPermissions } from './docAccess.js'
import type { EntityRef } from './entity.js'
import { defaultLocaleOf, entityOf, localesOf, targetLocalesOf } from './entity.js'
import {
  ConcurrentEditError,
  isUnrecoverable,
  LockLostError,
  PreviousFailure,
} from './errors.js'
import type { LocaleRun, Outcome, Previous, TranslationJobInput } from './localeRun.js'
import { assertLock, execute, LOCK_LOST, recordStamp } from './localeRun.js'
import { refreshLock, releaseLock } from './lock.js'
import type { RecordKey, TranslationRecord } from './records.js'
import { findRecord, recordKeyOf, saveRecord } from './records.js'
import { loadRequester, requesterOf } from './requester.js'
import type { TranslatorSettings } from './settings.js'
import type { TransactionID } from './transaction.js'

export type RawTranslationJobInput = Omit<
  TranslationJobInput,
  'sourceLocale' | 'targetLocales' | 'requester' | 'lockToken'
> & {
  sourceLocale?: string | null
  targetLocales: unknown
  requester?: unknown
  lockToken?: unknown
}

export const MISSING_REQUESTER = 'The user who requested the translation no longer exists'

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

type Stamp = ReturnType<typeof recordStamp>

const saveFailure = async ({
  payload,
  key,
  message,
  stamp,
  status = 'failed',
}: {
  payload: Payload
  key: RecordKey
  message: string
  stamp: Stamp
  status?: 'failed' | 'queued'
}): Promise<void> => {
  try {
    await saveRecord(payload, { key, data: { status, error: message, ...stamp } })
  } catch (err) {
    payload.logger.error({ err, msg: 'Could not save the translation failure' })
  }
}

// When nothing was translated, `translatedAt` keeps the date of the last real translation.
// Updating it would make `onLiveWrite` notify the website again with nothing changed.
const saveDone = async (
  { payload, input, sourceLocale }: Pick<LocaleRun, 'payload' | 'input' | 'sourceLocale'>,
  key: RecordKey,
  { hashes, kept, translated }: Outcome,
  transactionID: TransactionID | undefined,
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
      ...recordStamp(input),
    },
    transactionID,
  })
}

// While a retry is pending the record stays `queued` and the job keeps the lock, so a new
// POST cannot start another job that would run in parallel with this one. Once the lock is
// lost (a provider call that outlasted the busy window) the records belong to the newer
// request, which set them to `queued` for its own job: a `failed` written here would read
// as that job's failure, so the loss replaces the error and nothing is written.
const recordFailure = async (
  { payload, input }: Pick<LocaleRun, 'payload' | 'input'>,
  key: RecordKey,
  { error, isLastAttempt }: { error: unknown; isLastAttempt: boolean },
): Promise<unknown> => {
  if (error instanceof LockLostError) return error
  if (!(await refreshLock(payload, input, input.lockToken))) {
    return new LockLostError(LOCK_LOST)
  }
  const willRetry = !isLastAttempt && !isUnrecoverable(error)
  const retryNote = willRetry && error instanceof ConcurrentEditError
  await saveFailure({
    payload,
    key,
    message: retryNote ? `${messageOf(error)}; it will be retried` : messageOf(error),
    stamp: recordStamp(input),
    status: willRetry ? 'queued' : 'failed',
  })
  return error
}

// A record without `sourceLocale` was translated from the default locale. An entry
// without its own locale comes from the record's: it is stamped here so that it keeps
// that provenance once the record names the locale of this run.
const previousOf = (payload: Payload, record: TranslationRecord | null): Previous => {
  const sourceLocale = record?.sourceLocale ?? defaultLocaleOf(payload)
  const fields = Object.fromEntries(
    Object.entries(record?.fields ?? {}).map(([path, entry]) => [
      path,
      { sourceLocale, ...entry },
    ]),
  )
  return { fields, sourceLocale }
}

// The requester's access is checked again on every attempt, in the locales the job reads
// and writes, so a user who lost access since queueing gets nothing written.
const permissionsOf = (
  { payload, input, sourceLocale, targetLocale }: Omit<LocaleRun, 'permissions'>,
  user: TypedUser,
): ReturnType<typeof requesterPermissions> =>
  requesterPermissions({ payload, user, ref: input, sourceLocale, targetLocale })

// A `failed` record is this job's own earlier attempt only if it carries the job's lock
// token: the POST stamped the `queued` records with it. A record another holder wrote,
// or one from before the token existed, is just retried.
const previousFailure = (
  record: TranslationRecord | null,
  {
    lockToken,
    targetLocale,
  }: Pick<TranslationJobInput, 'lockToken'> & {
    targetLocale: string
  },
): PreviousFailure | null =>
  record?.status === 'failed' && record.lockToken === lockToken
    ? new PreviousFailure(record.error ?? `${targetLocale} failed`)
    : null

const translateLocale = async ({
  run,
  user,
  isLastAttempt,
}: {
  run: Omit<LocaleRun, 'permissions'>
  user: TypedUser
  isLastAttempt: boolean
}): Promise<{ error: unknown } | null> => {
  const { payload, input, targetLocale } = run
  const key = recordKeyOf(input, targetLocale)
  try {
    const record = await findRecord(payload, key)
    const failure = previousFailure(record, { lockToken: input.lockToken, targetLocale })
    if (failure) return { error: failure }
    const permissions = await permissionsOf(run, user)
    await assertLock(run)
    await saveRecord(payload, {
      key,
      data: { status: 'running', error: null, ...recordStamp(input) },
    })
    // The failure record below is written after the transaction was rolled back.
    await execute({ ...run, permissions }, previousOf(payload, record), (outcome, tx) =>
      saveDone(run, key, outcome, tx),
    )
    return null
  } catch (error) {
    return { error: await recordFailure(run, key, { error, isLastAttempt }) }
  }
}

// The records are marked only while the job still owns the lock; otherwise they already
// describe the newer request and the job is just cancelled as superseded.
const cancelAll = async ({
  payload,
  input,
  targets,
  message,
  lockToken,
}: {
  payload: Payload
  input: RawTranslationJobInput
  targets: string[]
  message: string
  lockToken: string
}): Promise<never> => {
  if (!(await refreshLock(payload, input, lockToken))) {
    throw new JobCancelledError(LOCK_LOST)
  }
  for (const targetLocale of targets) {
    await saveFailure({
      payload,
      key: recordKeyOf(input, targetLocale),
      message,
      stamp: { lockToken },
    })
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

const lockTokenOf = (raw: unknown): string | null =>
  typeof raw === 'string' ? raw : null

type Prepared = {
  run: Omit<LocaleRun, 'targetLocale' | 'permissions'>
  user: TypedUser
  targets: string[]
}

const prepare = async ({
  payload,
  input,
  settings,
  lockToken,
}: {
  payload: Payload
  input: RawTranslationJobInput
  settings: TranslatorSettings
  lockToken: string
}): Promise<Prepared> => {
  const name = nameOf(input)
  const requested = requestedLocales(input.targetLocales)
  const config = localesOf(settings, input)
  if (!config) {
    const message = `${name} is not translatable`
    return cancelAll({ payload, input, targets: requested, message, lockToken })
  }
  const sourceLocale = input.sourceLocale ?? defaultLocaleOf(payload)
  const targets = targetLocalesOf({ locales: config.locales, sourceLocale, requested })
  const cancel = (reason: string): Promise<never> =>
    cancelAll({ payload, input, targets, message: reason, lockToken })
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
      input: { ...input, sourceLocale, targetLocales: targets, requester, lockToken },
      entity,
      sourceLocale,
    },
    user,
    targets,
  }
}

type RunArgs = {
  payload: Payload
  input: RawTranslationJobInput
  settings: TranslatorSettings
  isLastAttempt: boolean
}

// Locales run in sequence inside a single job because each write saves the whole document
// from the latest version, so two parallel writes to the same document overwrite each
// other. Once the lock is lost, the locales still to come are not even tried: the newer
// job owns the document and its records now.
const translateAll = async (
  { payload, input, settings, isLastAttempt }: RunArgs,
  lockToken: string,
): Promise<void> => {
  const { run, user, targets } = await prepare({ payload, input, settings, lockToken })
  const errors: unknown[] = []
  for (const targetLocale of targets) {
    const failure = await translateLocale({
      run: { ...run, targetLocale },
      user,
      isLastAttempt,
    })
    if (!failure) continue
    errors.push(failure.error)
    if (failure.error instanceof LockLostError) break
  }
  throwFailures(errors)
}

// The lock is only deleted when the token still matches, so this is harmless after a
// take-over; failing to delete it only delays the next request until it expires.
const release = async (
  payload: Payload,
  input: EntityRef,
  token: string,
): Promise<void> => {
  try {
    await releaseLock(payload, input, token)
  } catch (err) {
    payload.logger.error({ err, msg: 'Could not release the translation lock' })
  }
}

// A job whose lock expired and was taken over by a newer request is cancelled without
// writing anything, not even its records: they already describe the newer request. The
// first check is a refresh: a lock about to expire (a retry after a long backoff) is
// extended before anything is read. Otherwise the lock is kept while a retry is pending
// and released when the job ends for good: success, cancellation or the last attempt.
export const runTranslation = async (args: RunArgs): Promise<void> => {
  const { payload, input, isLastAttempt } = args
  const token = lockTokenOf(input.lockToken)
  if (!token || !(await refreshLock(payload, input, token))) {
    throw new JobCancelledError(LOCK_LOST)
  }
  try {
    await translateAll(args, token)
  } catch (error) {
    if (error instanceof JobCancelledError || isLastAttempt)
      await release(payload, input, token)
    throw error
  }
  await release(payload, input, token)
}
