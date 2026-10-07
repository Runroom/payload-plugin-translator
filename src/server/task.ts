import type { TaskConfig } from 'payload'

import { JOB_RETRIES } from './limits.js'
import type { RawTranslationJobInput } from './runTranslation.js'
import { runTranslation } from './runTranslation.js'
import type { TranslatorSettings } from './settings.js'

/** Slug of the job task that translates one document into its target locales. */
export const TRANSLATE_TASK_SLUG = 'translateDocument'

// Two simultaneous POSTs can both get past the 409 and queue two jobs for the same
// document. Sharing a key stops Payload from running them at once (this requires
// `jobs.enableConcurrencyControl`, which the plugin turns on), and the second job then
// finds everything up to date and makes no provider calls.
export const concurrencyKeyOf = ({
  entityType,
  collectionSlug,
  docId,
}: Pick<RawTranslationJobInput, 'entityType' | 'collectionSlug' | 'docId'>): string =>
  `${entityType === 'global' ? 'global' : 'collection'}:${collectionSlug}:${docId}`

export const translateTask = (
  settings: TranslatorSettings,
): TaskConfig<{ input: RawTranslationJobInput; output: object }> => ({
  slug: TRANSLATE_TASK_SLUG,
  label: 'Translate document',
  concurrency: {
    exclusive: true,
    key: ({ input }) => concurrencyKeyOf(input),
  },
  inputSchema: [
    { name: 'entityType', type: 'select', options: ['collection', 'global'] },
    { name: 'collectionSlug', type: 'text', required: true },
    { name: 'docId', type: 'text', required: true },
    // Optional: without it the document is translated from the default locale.
    { name: 'sourceLocale', type: 'text' },
    { name: 'targetLocales', type: 'json', required: true },
    { name: 'overwriteEdited', type: 'checkbox' },
    // Who asked: the job reads and writes as this user, with their access at run time.
    { name: 'requester', type: 'json', required: true },
  ],
  retries: JOB_RETRIES,
  handler: async ({ input, job, req }) => {
    // `totalTried` counts the runs that already failed. Payload stops retrying once it
    // reaches `attempts`, so a run that starts there is the last one.
    await runTranslation({
      payload: req.payload,
      input: {
        ...input,
        // An input without `entityType` refers to a collection document.
        entityType: input.entityType === 'global' ? 'global' : 'collection',
        overwriteEdited: input.overwriteEdited === true,
      },
      settings,
      isLastAttempt: (job.totalTried ?? 0) >= JOB_RETRIES.attempts,
      jobCreatedAt: job.createdAt,
    })
    return { output: {} }
  },
})
