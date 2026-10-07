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

// The job writes after the POST has been answered, outside any Next request: there
// `revalidatePath` is lost (the route handler already flushed its pending revalidations)
// or throws (cron). `GET /status` is a real request, and the UI polls it when the job
// finishes, so the website is notified from here, once per translation. The record is
// marked even if the hook fails: retrying it on every poll would only fill the log.
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
    logger.warn({ err, msg: 'Translator onLiveWrite failed' })
  }
  const revalidatedAt = new Date().toISOString()
  for (const record of pending) {
    try {
      await markRevalidated(req.payload, { id: record.id, revalidatedAt })
    } catch (err) {
      logger.warn({ err, msg: 'Could not save the translation revalidatedAt' })
    }
  }
}
