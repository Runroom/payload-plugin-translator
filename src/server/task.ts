import type { TaskConfig } from 'payload'

import type { RawTranslationJobInput } from './runTranslation.js'
import { runTranslation } from './runTranslation.js'
import type { TranslatorSettings } from './settings.js'

export const TRANSLATE_TASK_SLUG = 'translateDocument'

const RETRIES = { attempts: 2, backoff: { type: 'exponential', delay: 10_000 } } as const

// Dos POST simultáneos pasan el 409 y encolan dos jobs del mismo documento; con la misma
// clave Payload no los corre a la vez (exige `jobs.enableConcurrencyControl`, que el
// plugin activa). El segundo, al correr, lo encuentra todo al día y no gasta.
export const concurrencyKeyOf = ({
  entityType,
  collectionSlug,
  docId,
}: Pick<RawTranslationJobInput, 'entityType' | 'collectionSlug' | 'docId'>): string =>
  `${entityType === 'global' ? 'global' : 'collection'}:${collectionSlug}:${docId}`

export const translateTask = (settings: TranslatorSettings): TaskConfig =>
  ({
    slug: TRANSLATE_TASK_SLUG,
    label: 'Traducir documento',
    concurrency: {
      exclusive: true,
      key: ({ input }: { input: RawTranslationJobInput }) => concurrencyKeyOf(input),
    },
    inputSchema: [
      { name: 'entityType', type: 'select', options: ['collection', 'global'] },
      { name: 'collectionSlug', type: 'text', required: true },
      { name: 'docId', type: 'text', required: true },
      // Opcional: los jobs encolados antes de poder elegir el origen no lo llevan.
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
      // `totalTried` cuenta las ejecuciones ya fallidas; Payload deja de reintentar cuando
      // llega a `attempts`, así que esta es la última.
      await runTranslation({
        payload: req.payload,
        input: {
          ...input,
          // Los jobs encolados antes de que existieran los globals no lo llevan.
          entityType: input.entityType === 'global' ? 'global' : 'collection',
          overwriteEdited: input.overwriteEdited === true,
        },
        settings,
        isLastAttempt: (job.totalTried ?? 0) >= RETRIES.attempts,
      })
      return { output: {} }
    },
  }) as unknown as TaskConfig
