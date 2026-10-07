import type {
  Block,
  CollectionConfig,
  Config,
  Field,
  GlobalConfig,
  Payload,
  Plugin,
} from 'payload'

import { findLocalizedContainers } from './core/schema.js'
import { en } from './i18n/en.js'
import { es } from './i18n/es.js'
import type { TranslationProvider } from './provider/types.js'
import { translatorEndpoints } from './server/endpoints.js'
import type { OnLiveWrite } from './server/liveWrites.js'
import { recordsCollection } from './server/records.js'
import type {
  EntityLocales,
  TranslatorAccess,
  TranslatorSettings,
} from './server/settings.js'
import { translateTask } from './server/task.js'

const CONTROL_COMPONENT = '@runroom/payload-plugin-translator/client#TranslateControl'

export type TranslatorEntityOptions = { locales?: string[] }

type EntityOptions = Record<string, TranslatorEntityOptions>

export type TranslatorPluginOptions = {
  collections: EntityOptions
  globals?: EntityOptions
  provider: TranslationProvider | null
  instructions?: (args: { sourceLocale: string; targetLocale: string }) => string
  access: TranslatorAccess
  queue?: string
  // Tells the website about what was written without drafts; see `server/liveWrites.ts`.
  onLiveWrite?: OnLiveWrite
}

const localeCodesOf = (config: Config): string[] => {
  const localization = config.localization
  if (!localization)
    throw new Error('translatorPlugin requires `localization` in the config')
  return localization.locales.map(locale =>
    typeof locale === 'string' ? locale : locale.code,
  )
}

const validateLocales = ({
  slug,
  locales,
  codes,
}: {
  slug: string
  locales: string[]
  codes: string[]
}): void => {
  const unknown = locales.filter(code => !codes.includes(code))
  if (unknown.length > 0) {
    throw new Error(
      `translatorPlugin: ${slug} uses locales that are not in \`localization\`: ${unknown.join(', ')}`,
    )
  }
  if (new Set(locales).size < 2) {
    throw new Error(
      `translatorPlugin: ${slug} needs at least two locales to translate between`,
    )
  }
}

const resolveEntities = ({
  options,
  existing,
  kind,
  config,
}: {
  options: EntityOptions
  existing: { slug: string }[]
  kind: string
  config: Config
}): Record<string, EntityLocales> => {
  const codes = localeCodesOf(config)
  const slugs = new Set(existing.map(entity => entity.slug))
  return Object.fromEntries(
    Object.entries(options).map(([slug, value]) => {
      if (!slugs.has(slug)) {
        throw new Error(`translatorPlugin: ${kind} ${slug} does not exist in the config`)
      }
      const locales = value.locales ?? codes
      validateLocales({ slug, locales, codes })
      return [slug, { locales: [...new Set(locales)] }]
    }),
  )
}

const resolveSettings = (
  options: TranslatorPluginOptions,
  config: Config,
): TranslatorSettings => ({
  collections: resolveEntities({
    options: options.collections,
    existing: config.collections ?? [],
    kind: 'collection',
    config,
  }),
  globals: resolveEntities({
    options: options.globals ?? {},
    existing: config.globals ?? [],
    kind: 'global',
    config,
  }),
  provider: options.provider,
  instructions: options.instructions ?? ((): string => ''),
  access: options.access,
  queue: options.queue ?? 'translations',
  onLiveWrite: options.onLiveWrite,
})

// The admin strings the plugin ships, by language. Spread them into
// `i18n.translations` to tweak a text or to add a language.
export const translatorTranslations = { en, es }

const refuseLocalizedContainers = ({
  slug,
  fields,
  blocks,
}: {
  slug: string
  fields: Field[]
  blocks: Block[]
}): void => {
  const containers = findLocalizedContainers(fields, blocks)
  if (containers.length > 0) {
    throw new Error(
      `translatorPlugin does not support localized containers in ${slug}: ${containers.join(', ')}`,
    )
  }
}

// A collection without drafts is translated too: the job writes directly and the drawer
// warns that it goes live at once (see `server/entity.ts`).
const withControl = ({
  collection,
  blocks,
}: {
  collection: CollectionConfig
  blocks: Block[]
}): CollectionConfig => {
  refuseLocalizedContainers({ slug: collection.slug, fields: collection.fields, blocks })
  const edit = collection.admin?.components?.edit
  return {
    ...collection,
    admin: {
      ...collection.admin,
      components: {
        ...collection.admin?.components,
        edit: {
          ...edit,
          beforeDocumentControls: [
            ...(edit?.beforeDocumentControls ?? []),
            CONTROL_COMPONENT,
          ],
        },
      },
    },
  }
}

// Payload 3.90 renders a global's `beforeDocumentControls` from `admin.components.elements`,
// not from `edit` as it does for collections.
const withGlobalControl = ({
  global,
  blocks,
}: {
  global: GlobalConfig
  blocks: Block[]
}): GlobalConfig => {
  refuseLocalizedContainers({ slug: global.slug, fields: global.fields, blocks })
  const elements = global.admin?.components?.elements
  return {
    ...global,
    admin: {
      ...global.admin,
      components: {
        ...global.admin?.components,
        elements: {
          ...elements,
          beforeDocumentControls: [
            ...(elements?.beforeDocumentControls ?? []),
            CONTROL_COMPONENT,
          ],
        },
      },
    },
  }
}

type Translations = Record<string, Record<string, unknown>>

type Catalog = { translator: Record<string, string> }

// The project's strings win: that way it can tweak one drawer text without losing the rest.
const mergeLanguage = (
  current: Record<string, unknown> | undefined,
  ours: Catalog,
): Record<string, unknown> => ({
  ...current,
  translator: {
    ...ours.translator,
    ...(current?.translator as Record<string, unknown> | undefined),
  },
})

// Every admin language gets the plugin's strings: one without a catalog of its own falls
// back to English instead of showing the raw keys.
const mergeTranslations = (
  config: Config,
): NonNullable<Config['i18n']>['translations'] => {
  const current = (config.i18n?.translations ?? {}) as Translations
  const catalogs = translatorTranslations as Record<string, Catalog>
  const languages = new Set([
    ...Object.keys(catalogs),
    ...Object.keys(config.i18n?.supportedLanguages ?? {}),
    ...Object.keys(current),
  ])
  return {
    ...current,
    ...Object.fromEntries(
      [...languages].map(language => [
        language,
        mergeLanguage(current[language], catalogs[language] ?? translatorTranslations.en),
      ]),
    ),
  } as NonNullable<Config['i18n']>['translations']
}

const schedulesQueue = async (payload: Payload, queue: string): Promise<boolean> => {
  const autoRun = payload.config.jobs.autoRun
  const entries = typeof autoRun === 'function' ? await autoRun(payload) : (autoRun ?? [])
  return entries.some(
    entry => entry.allQueues === true || (entry.queue ?? 'default') === queue,
  )
}

// A retryable error leaves the job waiting for its `waitUntil` and the record `queued`;
// with nothing running the queue again, that retry never comes. It is only a warning:
// in E2E runs or on serverless it may be deliberate.
const warnIfQueueUnscheduled = async (payload: Payload, queue: string): Promise<void> => {
  if (await schedulesQueue(payload, queue)) return
  payload.logger.warn(
    `translatorPlugin: no \`jobs.autoRun\` entry processes the "${queue}" queue. Retries of a failed translation will not run until something runs the queue again (for example \`autoRun: [{ cron: '* * * * *', queue: '${queue}' }]\` or an external cron).`,
  )
}

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
