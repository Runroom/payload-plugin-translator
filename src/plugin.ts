import type { Config, Plugin } from 'payload'

import { mergeTranslations } from './i18n/index.js'
import { withControl, withGlobalControl } from './plugin/admin.js'
import { warnIfQueueUnscheduled } from './plugin/queue.js'
import type { TranslatorPluginOptions } from './plugin/settings.js'
import { resolveSettings } from './plugin/settings.js'
import { translatorEndpoints } from './server/endpoints.js'
import { recordsCollection } from './server/records.js'
import { translateTask } from './server/task.js'

/**
 * Adds AI translation of localized fields to the configured collections and globals: a
 * "Translate" control in the admin, the `/api/translator/*` endpoints, the
 * `translation-records` collection and the `translateDocument` job task.
 *
 * @example
 * ```ts
 * translatorPlugin({
 *   collections: { pages: {}, posts: { locales: ['en', 'es'] } },
 *   globals: { footer: {} },
 *   provider: process.env.OPENAI_API_KEY
 *     ? openAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-5-mini' })
 *     : null,
 *   access: ({ req }) => Boolean(req.user),
 * })
 * ```
 */
export const translatorPlugin =
  (options: TranslatorPluginOptions): Plugin =>
  (config: Config): Config => {
    const settings = resolveSettings(options, config)
    return {
      ...config,
      onInit: async payload => {
        await config.onInit?.(payload)
        // Without a provider nothing is translated, so there are no retries to miss.
        if (settings.provider) await warnIfQueueUnscheduled(payload, settings.queue)
      },
      collections: [
        ...(config.collections ?? []).map(collection =>
          settings.collections[collection.slug]
            ? withControl({ collection, blocks: config.blocks ?? [] })
            : collection,
        ),
        recordsCollection(),
      ],
      globals: (config.globals ?? []).map(global =>
        settings.globals[global.slug]
          ? withGlobalControl({ global, blocks: config.blocks ?? [] })
          : global,
      ),
      endpoints: [...(config.endpoints ?? []), ...translatorEndpoints(settings)],
      jobs: {
        ...config.jobs,
        // The task's concurrency key has no effect without this. Turning it on adds the
        // indexed `concurrencyKey` column to the jobs collection, so the project needs a
        // migration. An explicit `false` in the project config wins.
        enableConcurrencyControl: config.jobs?.enableConcurrencyControl ?? true,
        tasks: [...(config.jobs?.tasks ?? []), translateTask(settings)],
      },
      i18n: { ...config.i18n, translations: mergeTranslations(config) },
    }
  }
