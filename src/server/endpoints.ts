import type { Endpoint, PayloadRequest } from 'payload'

import type { TranslateQueuedBody, TranslatorErrorBody } from '../shared/api.js'
import { isPendingState, STATUS_PATH, TRANSLATE_PATH } from '../shared/api.js'
import { docPermissions } from './docAccess.js'
import type { EntityRef } from './entity.js'
import { entityOf, GLOBAL_DOC_ID, localesOf, targetLocalesOf } from './entity.js'
import type { Requester } from './localeRun.js'
import { acquireLock, releaseLock } from './lock.js'
import { findRecords, saveRecord } from './records.js'
import type { EntityLocales, TranslatorSettings } from './settings.js'
import { buildStatus } from './status.js'
import { TRANSLATE_TASK_SLUG } from './task.js'

type TranslateBody = {
  ref: EntityRef
  sourceLocale: string
  targetLocales: string[]
  overwriteEdited: boolean
}

const json = (body: unknown, status: number): Response => Response.json(body, { status })

const fail = (body: TranslatorErrorBody, status: number): Response => json(body, status)

// A global is identified by `global`, a document by `collection` + `id`.
const refOf = (value: {
  global?: unknown
  collection?: unknown
  id?: unknown
}): EntityRef | null => {
  if (typeof value.global === 'string') {
    return { entityType: 'global', collectionSlug: value.global, docId: GLOBAL_DOC_ID }
  }
  if (typeof value.collection !== 'string' || typeof value.id !== 'string') return null
  return { entityType: 'collection', collectionSlug: value.collection, docId: value.id }
}

const parseBody = (body: unknown): TranslateBody | null => {
  const value = body as Record<string, unknown> | null
  const ref = value ? refOf(value) : null
  if (
    !value ||
    !ref ||
    typeof value.sourceLocale !== 'string' ||
    !Array.isArray(value.targetLocales)
  )
    return null
  return {
    ref,
    sourceLocale: value.sourceLocale,
    targetLocales: value.targetLocales.filter(
      (item): item is string => typeof item === 'string',
    ),
    overwriteEdited: value.overwriteEdited === true,
  }
}

type Translation = {
  req: PayloadRequest
  settings: TranslatorSettings
  body: TranslateBody
  targets: string[]
  requester: Requester
  lockToken: string
}

// The records are written before the job is queued: a job claimed by the cron can finish
// (and be deleted) before this request gets to its records, and writing `queued` after
// that would hide a finished translation for the busy window. They carry the lock's token
// so the job can tell its own records from an older job's.
const saveQueued = async ({
  req,
  body,
  targets,
  lockToken,
}: Translation): Promise<void> => {
  for (const targetLocale of targets) {
    const key = { ...body.ref, targetLocale }
    await saveRecord(req.payload, {
      key,
      data: { status: 'queued', error: null, lockToken },
    })
  }
}

const queueJob = async ({
  req,
  settings,
  body,
  targets,
  requester,
  lockToken,
}: Translation): Promise<{ id: string | number }> =>
  (await req.payload.jobs.queue({
    task: TRANSLATE_TASK_SLUG as never,
    queue: settings.queue,
    input: {
      ...body.ref,
      sourceLocale: body.sourceLocale,
      targetLocales: targets,
      overwriteEdited: body.overwriteEdited,
      requester,
      lockToken,
    } as never,
  })) as unknown as { id: string | number }

// Nothing was queued, so the document is unlocked again and the records say so. These
// writes are best effort: an expired lock and an expired record stop blocking on their own.
const undoQueued = async (
  { req, body, targets, lockToken }: Translation,
  error: unknown,
): Promise<void> => {
  const { payload } = req
  payload.logger.error({ err: error, msg: 'Translator could not queue the translation' })
  for (const targetLocale of targets) {
    const key = { ...body.ref, targetLocale }
    await saveRecord(payload, {
      key,
      data: { status: 'failed', error: 'The translation could not be queued' },
    }).catch((err: unknown) => {
      payload.logger.error({ err, msg: 'Translator records save failed' })
    })
  }
  await releaseLock(payload, body.ref, lockToken).catch((err: unknown) => {
    payload.logger.error({ err, msg: 'Could not release the translation lock' })
  })
}

// Run the job now instead of waiting for the cron, without awaiting it, because the
// translation takes longer than an HTTP response should. On a long-lived Node process the
// promise outlives the response. The cron only picks up queued jobs nobody ran (after a
// restart, for instance) and does not rescue one that was in progress; E2E runs have no
// cron. The run filters by id because `run` without `where` takes the oldest jobs in the
// queue, not necessarily this one. `runByID` is not used because it runs the job even
// while the cron is already processing it.
const startJob = ({ req, settings }: Translation, job: { id: string | number }): void => {
  void req.payload.jobs
    .run({ queue: settings.queue, limit: 1, where: { id: { in: [job.id] } } })
    .catch((error: unknown) => {
      req.payload.logger.error({ err: error, msg: 'Translator queue run failed' })
    })
}

// Either the records and the job both exist or neither does: a failure anywhere answers a
// plain 500 with the lock released, so the client knows nothing started.
const queueTranslation = async (translation: Translation): Promise<Response> => {
  try {
    await saveQueued(translation)
    const job = await queueJob(translation)
    startJob(translation, job)
  } catch (error) {
    await undoQueued(translation, error)
    return fail({ error: 'failed' }, 500)
  }
  const queued: TranslateQueuedBody = { queued: translation.targets }
  return json(queued, 202)
}

// Called only while another request holds the lock, so every pending record is busy,
// however old its heartbeat. Before the holder has saved its records, the requested
// targets are reported instead.
const busyLocales = async (
  req: PayloadRequest,
  body: TranslateBody,
  targets: string[],
): Promise<string[]> => {
  const records = await findRecords(req.payload, body.ref)
  const busy = records
    .filter(item => isPendingState(item.status))
    .map(item => item.targetLocale)
  return busy.length > 0 ? busy : targets
}

const readBody = async (req: PayloadRequest): Promise<unknown> => {
  try {
    return await req.json?.()
  } catch {
    return null
  }
}

const entityExists = async ({
  req,
  ref,
  locale,
}: {
  req: PayloadRequest
  ref: EntityRef
  locale: string
}): Promise<boolean> => {
  const entity = entityOf(req.payload, ref)
  return entity !== null && (await entity.find({ locale })) !== null
}

const targetsOf = (body: TranslateBody, config: EntityLocales): string[] | null => {
  if (!config.locales.includes(body.sourceLocale)) return null
  const targets = targetLocalesOf({
    locales: config.locales,
    sourceLocale: body.sourceLocale,
    requested: body.targetLocales,
  })
  return targets.length > 0 ? targets : null
}

// An unconfigured global does not exist as far as the translator is concerned (404); an
// unconfigured collection is a malformed request (400).
const resolveTargets = (
  settings: TranslatorSettings,
  body: TranslateBody,
): Response | string[] => {
  const config = localesOf(settings, body.ref)
  if (!config) {
    const isGlobal = body.ref.entityType === 'global'
    return fail({ error: isGlobal ? 'not-found' : 'bad-request' }, isGlobal ? 404 : 400)
  }
  return targetsOf(body, config) ?? fail({ error: 'bad-request' }, 400)
}

// Without read access in the source locale the document does not exist for the requester
// (404). Without update access in every target locale the request is denied (403), since
// translating writes to the document there and, without drafts, publishes it. The job
// checks all of this again when it runs.
const checkDocument = async ({
  req,
  body,
  targets,
}: {
  req: PayloadRequest
  body: TranslateBody
  targets: string[]
}): Promise<Response | null> => {
  const { ref, sourceLocale } = body
  if (!(await entityExists({ req, ref, locale: sourceLocale })))
    return fail({ error: 'not-found' }, 404)
  const source = await docPermissions({ req, ref, locale: sourceLocale })
  if (!source.read) return fail({ error: 'not-found' }, 404)
  for (const locale of targets) {
    const target = await docPermissions({ req, ref, locale })
    if (!target.update) return fail({ error: 'forbidden' }, 403)
  }
  return null
}

// The job acts as the requester, so a request without a user has nobody to act as. The
// plugin's `access` normally denies it already.
const requesterOf = (req: PayloadRequest): Requester | null =>
  req.user ? { collection: req.user.collection, id: String(req.user.id) } : null

const translateEndpoint = (settings: TranslatorSettings): Endpoint => ({
  path: TRANSLATE_PATH,
  method: 'post',
  handler: async req => {
    // The body is parsed before `access` so the document can be passed to it. A requester
    // without access gets 400 instead of 403 for a malformed body, which reveals nothing.
    const body = parseBody(await readBody(req))
    if (!body) return fail({ error: 'bad-request' }, 400)
    if (!(await settings.access({ req, ref: body.ref, operation: 'translate' })))
      return fail({ error: 'forbidden' }, 403)
    const requester = requesterOf(req)
    if (!requester) return fail({ error: 'forbidden' }, 403)
    if (!settings.provider) return fail({ error: 'not-configured' }, 503)
    const targets = resolveTargets(settings, body)
    if (!Array.isArray(targets)) return targets
    const denied = await checkDocument({ req, body, targets })
    if (denied) return denied

    // The lock is per document, not per locale, because two jobs for the same document
    // would write in parallel and one would overwrite the other. Taking it is atomic, so
    // of two simultaneous requests exactly one gets past this point.
    const lockToken = await acquireLock(req.payload, body.ref)
    if (!lockToken) {
      return fail({ error: 'busy', busy: await busyLocales(req, body, targets) }, 409)
    }
    return queueTranslation({ req, settings, body, targets, requester, lockToken })
  },
})

const statusEndpoint = (settings: TranslatorSettings): Endpoint => ({
  path: STATUS_PATH,
  method: 'get',
  handler: async req => {
    const params = req.searchParams
    const ref = refOf({
      global: params.get('global') ?? undefined,
      collection: params.get('collection') ?? undefined,
      id: params.get('id') ?? undefined,
    })
    if (!(await settings.access({ req, ref: ref ?? undefined, operation: 'status' })))
      return fail({ error: 'forbidden' }, 403)
    const status = ref ? await buildStatus({ req, settings, ref }) : null
    return status ? json(status, 200) : fail({ error: 'not-found' }, 404)
  },
})

export const translatorEndpoints = (settings: TranslatorSettings): Endpoint[] => [
  translateEndpoint(settings),
  statusEndpoint(settings),
]
