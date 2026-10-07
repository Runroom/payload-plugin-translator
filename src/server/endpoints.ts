import type { Endpoint, PayloadRequest, SanitizedFieldsPermissions } from 'payload'

import type { TranslateQueuedBody, TranslatorErrorBody } from '../shared/api.js'
import { STATUS_PATH, TRANSLATE_PATH } from '../shared/api.js'
import { docPermissions } from './docAccess.js'
import type { EntityRef } from './entity.js'
import { entityOf, GLOBAL_DOC_ID, localesOf } from './entity.js'
import { findRecords, saveRecord } from './records.js'
import type { EntityLocales, TranslatorSettings } from './settings.js'
import { buildStatus, isBusy } from './status.js'
import { TRANSLATE_TASK_SLUG } from './task.js'

type TranslateBody = {
  ref: EntityRef
  sourceLocale: string
  targetLocales: string[]
  overwriteEdited: boolean
}

const json = (body: unknown, status: number): Response => Response.json(body, { status })

// Every error goes through here so the codes are checked against the shared contract.
const fail = (body: TranslatorErrorBody, status: number): Response => json(body, status)

// A global is requested by `global`; a document, by `collection` + `id`.
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

const queueTranslations = async ({
  req,
  settings,
  body,
  targets,
  fieldPermissions,
}: {
  req: PayloadRequest
  settings: TranslatorSettings
  body: TranslateBody
  targets: string[]
  fieldPermissions: SanitizedFieldsPermissions
}): Promise<{ recordsSaved: boolean }> => {
  // The job goes before the records: a `queued` record without a job would lock the
  // document with 409 until it expires.
  const job = (await req.payload.jobs.queue({
    task: TRANSLATE_TASK_SLUG as never,
    queue: settings.queue,
    input: {
      ...body.ref,
      sourceLocale: body.sourceLocale,
      targetLocales: targets,
      overwriteEdited: body.overwriteEdited,
      fieldPermissions,
    } as never,
  })) as unknown as { id: string | number }
  // If the records fail, the job already exists: it is run anyway, because it sets them to
  // `running`/`done` itself when it runs (`saveRecord` creates any that is missing), so it
  // is not left orphaned waiting for the cron. The response does warn (500): the client
  // cannot assume the document got locked.
  let recordsSaved = true
  try {
    for (const targetLocale of targets) {
      const key = { ...body.ref, targetLocale }
      await saveRecord(req.payload, { key, data: { status: 'queued', error: null } })
    }
  } catch (error) {
    recordsSaved = false
    req.payload.logger.error({ err: error, msg: 'Translator records save failed' })
  }
  // It is run when queued so it does not wait for the cron, and without awaiting it because
  // the translation does not fit in the HTTP response: the server is a long-lived Node
  // process and the promise outlives the response. The cron only runs queued jobs nobody
  // ran (after a restart, for instance) and does not rescue one that was in progress; E2E
  // runs have no cron. It filters by id because `run` without `where` takes the oldest jobs
  // in the queue, not this one; `runByID` does not work because it runs the job even while
  // the cron is already processing it.
  void req.payload.jobs
    .run({ queue: settings.queue, limit: 1, where: { id: { in: [job.id] } } })
    .catch((error: unknown) => {
      req.payload.logger.error({ err: error, msg: 'Translator queue run failed' })
    })
  return { recordsSaved }
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

// The source is the locale open in the admin; the targets, any other locale of the entity.
const targetsOf = (body: TranslateBody, config: EntityLocales): string[] | null => {
  if (!config.locales.includes(body.sourceLocale)) return null
  const targets = body.targetLocales.filter(
    locale => config.locales.includes(locale) && locale !== body.sourceLocale,
  )
  return targets.length > 0 ? targets : null
}

// A global that is not configured does not exist for the translator; an unconfigured
// collection is a malformed request.
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

// Without read access the document does not exist for the requester; without update
// access, the request is denied: translating writes to it (and, without drafts, publishes).
// Allowed, it answers the requester's field permissions, which the job honours.
const checkDocument = async ({
  req,
  body,
}: {
  req: PayloadRequest
  body: TranslateBody
}): Promise<Response | SanitizedFieldsPermissions> => {
  if (!(await entityExists({ req, ref: body.ref, locale: body.sourceLocale })))
    return fail({ error: 'not-found' }, 404)
  const permissions = await docPermissions({ req, ref: body.ref })
  if (!permissions.read) return fail({ error: 'not-found' }, 404)
  if (!permissions.update) return fail({ error: 'forbidden' }, 403)
  return permissions.fields
}

const translateEndpoint = (settings: TranslatorSettings): Endpoint => ({
  path: TRANSLATE_PATH,
  method: 'post',
  handler: async req => {
    // The body is parsed before `access` so the document can be passed to it; a requester
    // without access gets 400 instead of 403 for a malformed body, and learns nothing else.
    const body = parseBody(await readBody(req))
    if (!body) return fail({ error: 'bad-request' }, 400)
    if (!(await settings.access({ req, ref: body.ref, operation: 'translate' })))
      return fail({ error: 'forbidden' }, 403)
    if (!settings.provider) return fail({ error: 'not-configured' }, 503)
    const targets = resolveTargets(settings, body)
    if (!Array.isArray(targets)) return targets
    const fieldPermissions = await checkDocument({ req, body })
    if (fieldPermissions instanceof Response) return fieldPermissions

    const records = await findRecords(req.payload, body.ref)
    // The lock is per document, not per locale: two jobs for the same document at once
    // would write in parallel and one would overwrite the other.
    const busy = records.filter(isBusy).map(item => item.targetLocale)
    if (busy.length > 0) return fail({ error: 'busy', busy }, 409)

    const { recordsSaved } = await queueTranslations({
      req,
      settings,
      body,
      targets,
      fieldPermissions,
    })
    if (!recordsSaved) return fail({ error: 'records-failed', queued: targets }, 500)
    const queued: TranslateQueuedBody = { queued: targets }
    return json(queued, 202)
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
