import type { TaskConfig } from 'payload'

import type { RawTranslationJobInput } from './runTranslation.js'
import { runTranslation } from './runTranslation.js'
import type { TranslatorSettings } from './settings.js'

export const TRANSLATE_TASK_SLUG = 'translateDocument'

const RETRIES = { attempts: 2, backoff: { type: 'exponential', delay: 10_000 } } as const

// Two simultaneous POSTs get past the 409 and queue two jobs for the same document; with
// the same key Payload does not run them at once (it requires
// `jobs.enableConcurrencyControl`, which the plugin turns on). The second one, when it
// runs, finds everything up to date and spends nothing.
export const concurrencyKeyOf = ({
  entityType,
  collectionSlug,
  docId,
}: Pick<RawTranslationJobInput, 'entityType' | 'collectionSlug' | 'docId'>): string =>
  `${entityType === 'global' ? 'global' : 'collection'}:${collectionSlug}:${docId}`

export const translateTask = (settings: TranslatorSettings): TaskConfig =>
  ({
    slug: TRANSLATE_TASK_SLUG,
    label: 'Translate document',
    concurrency: {
      exclusive: true,
      key: ({ input }: { input: RawTranslationJobInput }) => concurrencyKeyOf(input),
    },
    inputSchema: [
      { name: 'entityType', type: 'select', options: ['collection', 'global'] },
      { name: 'collectionSlug', type: 'text', required: true },
      { name: 'docId', type: 'text', required: true },
      // Optional: an input without it is translated from the default locale.
      { name: 'sourceLocale', type: 'text' },
      { name: 'targetLocales', type: 'json', required: true },
      { name: 'overwriteEdited', type: 'checkbox' },
    ],
    retries: RETRIES,
    handler: async ({
      input,
      job,
      req,
    }: {
      input: RawTranslationJobInput
      job: { totalTried?: number }
      req: { payload: never }
    }) => {
      // `totalTried` counts the runs that already failed; Payload stops retrying when it
      // reaches `attempts`, so this one is the last.
      await runTranslation({
        payload: req.payload,
        input: {
          ...input,
          // An input without `entityType` refers to a collection document.
          entityType: input.entityType === 'global' ? 'global' : 'collection',
          overwriteEdited: input.overwriteEdited === true,
        },
        settings,
        isLastAttempt: (job.totalTried ?? 0) >= RETRIES.attempts,
      })
      return { output: {} }
    },
  }) as unknown as TaskConfig
