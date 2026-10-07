import type { TaskConfig } from 'payload'

import { JOB_RETRIES } from './limits.js'
import type { RawTranslationJobInput } from './runTranslation.js'
import { runTranslation } from './runTranslation.js'
import type { TranslatorSettings } from './settings.js'

/** Slug of the job task that translates one document into its target locales. */
export const TRANSLATE_TASK_SLUG = 'translateDocument'

// Two jobs for the same document never run at once because `POST /translate` only queues
// one while it holds the document's lock (`translation-locks`), and the job checks that
// it still owns that lock on every attempt. Payload's own `concurrency` option is not
// used: its check is not atomic across runners.
export const translateTask = (
  settings: TranslatorSettings,
): TaskConfig<{ input: RawTranslationJobInput; output: object }> => ({
  slug: TRANSLATE_TASK_SLUG,
  label: 'Translate document',
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
    // The document lock the request took; the job cancels itself if it no longer owns it.
    { name: 'lockToken', type: 'text', required: true },
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
