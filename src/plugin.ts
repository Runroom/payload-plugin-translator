import type { Config, Plugin } from 'payload'

import { mergeTranslations } from './i18n/index.js'
import { withControl, withGlobalControl } from './plugin/admin.js'
import { warnIfQueueUnscheduled } from './plugin/queue.js'
import type { TranslatorPluginOptions } from './plugin/settings.js'
import { resolveSettings } from './plugin/settings.js'
import { translatorEndpoints } from './server/endpoints.js'
import { recordsCollection } from './server/records.js'
import { translateTask } from './server/task.js'

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
        // The task's concurrency key only counts with this on; it adds the indexed
        // `concurrencyKey` column to the jobs collection (a migration in the project). An
        // explicit `false` from the project is respected.
        enableConcurrencyControl: config.jobs?.enableConcurrencyControl ?? true,
        tasks: [...(config.jobs?.tasks ?? []), translateTask(settings)],
      },
      i18n: { ...config.i18n, translations: mergeTranslations(config) },
    }
  }
