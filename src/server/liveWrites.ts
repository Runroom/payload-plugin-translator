import type { PayloadRequest } from 'payload'

import type { EntityRef } from './entity.js'
import type { TranslationRecord } from './records.js'
import { markRevalidated } from './records.js'
import type { TranslatorSettings } from './settings.js'

export type OnLiveWrite = (args: {
  req: PayloadRequest
  entityType: EntityRef['entityType']
  slug: string
  docId: string | null
  locales: string[]
}) => void | Promise<void>

const needsRevalidation = (record: TranslationRecord): boolean =>
  record.status === 'done' &&
  record.translatedAt !== null &&
  (!record.revalidatedAt ||
    Date.parse(record.translatedAt) > Date.parse(record.revalidatedAt))

// El job escribe después de responder al POST, fuera de cualquier request de Next: ahí
// `revalidatePath` se pierde (el route handler ya vació sus revalidaciones pendientes) o
// lanza (cron). `GET /status` sí es una request real, y la interfaz lo consulta al
// terminar, así que el aviso a la web se da desde aquí, una vez por traducción. Se marca
// también si el gancho falla: reintentarlo en cada sondeo solo llenaría el log.
export const notifyLiveWrites = async ({
  req,
  settings,
  ref,
  records,
}: {
  req: PayloadRequest
  settings: TranslatorSettings
  ref: EntityRef
  records: (TranslationRecord & { targetLocale: string })[]
}): Promise<void> => {
  const hook = settings.onLiveWrite
  const pending = records.filter(needsRevalidation)
  if (!hook || pending.length === 0) return
  const { logger } = req.payload
  try {
    await hook({
      req,
      entityType: ref.entityType,
      slug: ref.collectionSlug,
      docId: ref.entityType === 'global' ? null : ref.docId,
      locales: pending.map(record => record.targetLocale),
    })
  } catch (err) {
    logger.warn({ err, msg: 'onLiveWrite del traductor ha fallado' })
  }
  const revalidatedAt = new Date().toISOString()
  for (const record of pending) {
    try {
      await markRevalidated(req.payload, { id: record.id, revalidatedAt })
    } catch (err) {
      logger.warn({ err, msg: 'No se pudo guardar revalidatedAt de la traducción' })
    }
  }
}
