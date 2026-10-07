import type { PayloadRequest } from 'payload'

import type { EntityRef } from './entity.js'
import type { TranslationRecord } from './records.js'
import { markRevalidated } from './records.js'
import type { TranslatorSettings } from './settings.js'

/**
 * Called after a finished translation of an entity without drafts, so you can revalidate
 * the public site (for example with Next's `revalidatePath`). It runs from `GET /status`,
 * which the admin polls until the job ends, so it does not fire until someone requests the
 * status. `docId` is `null` for globals. Errors are logged and not retried.
 *
 * It must be idempotent: two overlapping status polls can both find the translation not
 * yet notified and call it twice for the same locales. Revalidating twice is harmless.
 */
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

// The job writes after the POST has been answered, outside any Next request, where
// `revalidatePath` is either lost (the route handler already flushed its pending
// revalidations) or throws (cron). `GET /status` is a real request that the UI polls until
// the job finishes, so the website is notified from here. The record is marked even if the
// hook fails, because retrying it on every poll would only fill the log. The mark is not
// claimed atomically: Payload's `update` with a `where` is a find followed by an update
// per id, not a single conditional write, so two overlapping polls can both read the
// translation as not notified and call the hook twice, which is why it must be idempotent.
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
  const pending = records
    .filter(needsRevalidation)
    .map(record => ({ record, translatedAt: record.translatedAt! }))
  if (!hook || pending.length === 0) return
  const { logger } = req.payload
  try {
    await hook({
      req,
      entityType: ref.entityType,
      slug: ref.collectionSlug,
      docId: ref.entityType === 'global' ? null : ref.docId,
      locales: pending.map(({ record }) => record.targetLocale),
    })
  } catch (err) {
    logger.warn({ err, msg: 'Translator onLiveWrite failed' })
  }
  // Mark with the `translatedAt` that was notified, not with the current time, so a
  // translation that finishes while the hook runs stays newer than the mark and is
  // notified on the next poll.
  for (const { record, translatedAt } of pending) {
    try {
      await markRevalidated(req.payload, {
        id: record.id,
        revalidatedAt: translatedAt,
      })
    } catch (err) {
      logger.warn({ err, msg: 'Could not save the translation revalidatedAt' })
    }
  }
}
