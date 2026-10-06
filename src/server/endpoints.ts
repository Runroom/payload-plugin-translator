import type { Endpoint, PayloadRequest } from 'payload'

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

// Un global se pide por `global`; un documento, por `collection` + `id`.
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
}: {
  req: PayloadRequest
  settings: TranslatorSettings
  body: TranslateBody
  targets: string[]
}): Promise<{ recordsSaved: boolean }> => {
  // El job va antes que los registros: un `queued` sin job bloquearía el documento con
  // 409 hasta que caduque.
  const job = (await req.payload.jobs.queue({
    task: TRANSLATE_TASK_SLUG as never,
    queue: settings.queue,
    input: {
      ...body.ref,
      sourceLocale: body.sourceLocale,
      targetLocales: targets,
      overwriteEdited: body.overwriteEdited,
    } as never,
  })) as unknown as { id: string | number }
  // Si fallan los registros el job ya existe: se lanza igual, porque él mismo los deja
  // en `running`/`done` al correr (`saveRecord` crea el que falte), y no queda huérfano
  // esperando al cron. La respuesta sí avisa (500): el cliente no puede dar por hecho que
  // el documento quedó bloqueado.
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
  // Se lanza al encolar para no esperar al cron, y sin esperar porque la traducción no
  // cabe en la respuesta HTTP: el servidor es un proceso Node de larga vida y la promesa
  // sobrevive a la respuesta. El cron solo lanza jobs encolados que nadie ejecutó (por
  // ejemplo tras un reinicio) y no rescata uno que estaba en curso; en E2E no hay cron.
  // Se filtra por id porque `run` sin `where` coge los jobs más antiguos de la cola, no
  // este; `runByID` no sirve porque ejecuta el job aunque el cron ya lo esté procesando.
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

// El origen es el idioma abierto en el admin; los destinos, cualquier otro de la entidad.
const targetsOf = (body: TranslateBody, config: EntityLocales): string[] | null => {
  if (!config.locales.includes(body.sourceLocale)) return null
  const targets = body.targetLocales.filter(
    locale => config.locales.includes(locale) && locale !== body.sourceLocale,
  )
  return targets.length > 0 ? targets : null
}

// Un global que no está configurado no existe para el traductor; una colección sin
// configurar es una petición mal hecha.
const resolveTargets = (
  settings: TranslatorSettings,
  body: TranslateBody,
): Response | string[] => {
  const config = localesOf(settings, body.ref)
  if (!config) {
    const isGlobal = body.ref.entityType === 'global'
    return json({ error: isGlobal ? 'not-found' : 'bad-request' }, isGlobal ? 404 : 400)
  }
  return targetsOf(body, config) ?? json({ error: 'bad-request' }, 400)
}

// Sin lectura el documento no existe para quien pide; sin actualización, se le niega:
// traducir escribe en él (y sin borradores, publica).
const refuseDocument = async ({
  req,
  body,
}: {
  req: PayloadRequest
  body: TranslateBody
}): Promise<Response | null> => {
  if (!(await entityExists({ req, ref: body.ref, locale: body.sourceLocale })))
    return json({ error: 'not-found' }, 404)
  const permissions = await docPermissions({ req, ref: body.ref })
  if (!permissions.read) return json({ error: 'not-found' }, 404)
  if (!permissions.update) return json({ error: 'forbidden' }, 403)
  return null
}

const translateEndpoint = (settings: TranslatorSettings): Endpoint => ({
  path: '/translator/translate',
  method: 'post',
  handler: async req => {
    // El cuerpo va antes que `access` para poder pasarle el documento; a quien no tiene
    // acceso un cuerpo malformado le da 400 en vez de 403, y no se le cuenta nada más.
    const body = parseBody(await readBody(req))
    if (!body) return json({ error: 'bad-request' }, 400)
    if (!(await settings.access({ req, ref: body.ref, operation: 'translate' })))
      return json({ error: 'forbidden' }, 403)
    if (!settings.provider) return json({ error: 'not-configured' }, 503)
    const targets = resolveTargets(settings, body)
    if (!Array.isArray(targets)) return targets
    const refused = await refuseDocument({ req, body })
    if (refused) return refused

    const records = await findRecords(req.payload, body.ref)
    // El bloqueo es por documento y no por idioma: dos jobs del mismo documento a la vez
    // escribirían en paralelo y una pisaría a la otra.
    const busy = records.filter(isBusy).map(item => item.targetLocale)
    if (busy.length > 0) return json({ error: 'busy', busy }, 409)

    const { recordsSaved } = await queueTranslations({ req, settings, body, targets })
    if (!recordsSaved) return json({ error: 'records-failed', queued: targets }, 500)
    return json({ queued: targets }, 202)
  },
})

const statusEndpoint = (settings: TranslatorSettings): Endpoint => ({
  path: '/translator/status',
  method: 'get',
  handler: async req => {
    const params = req.searchParams
    const ref = refOf({
      global: params.get('global') ?? undefined,
      collection: params.get('collection') ?? undefined,
      id: params.get('id') ?? undefined,
    })
    if (!(await settings.access({ req, ref: ref ?? undefined, operation: 'status' })))
      return json({ error: 'forbidden' }, 403)
    const status = ref ? await buildStatus({ req, settings, ref }) : null
    return status ? json(status, 200) : json({ error: 'not-found' }, 404)
  },
})

export const translatorEndpoints = (settings: TranslatorSettings): Endpoint[] => [
  translateEndpoint(settings),
  statusEndpoint(settings),
]
