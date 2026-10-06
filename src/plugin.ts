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
  // Avisa a la web de lo que se escribió sin borradores; ver `server/liveWrites.ts`.
  onLiveWrite?: OnLiveWrite
}

const localeCodesOf = (config: Config): string[] => {
  const localization = config.localization
  if (!localization)
    throw new Error('translatorPlugin necesita `localization` en la config')
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
      `translatorPlugin: ${slug} usa idiomas que no están en \`localization\`: ${unknown.join(', ')}`,
    )
  }
  if (new Set(locales).size < 2) {
    throw new Error(
      `translatorPlugin: ${slug} necesita al menos dos idiomas entre los que traducir`,
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
        throw new Error(`translatorPlugin: ${kind} ${slug} no existe en la config`)
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
    kind: 'la colección',
    config,
  }),
  globals: resolveEntities({
    options: options.globals ?? {},
    existing: config.globals ?? [],
    kind: 'el global',
    config,
  }),
  provider: options.provider,
  instructions: options.instructions ?? ((): string => ''),
  access: options.access,
  queue: options.queue ?? 'translations',
  onLiveWrite: options.onLiveWrite,
})

const translatorTranslations = { es, en }

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
      `translatorPlugin no admite contenedores localizados en ${slug}: ${containers.join(', ')}`,
    )
  }
}

// Una colección sin borradores también se traduce: el job escribe directo y el drawer
// avisa de que se publica al momento (ver `server/entity.ts`).
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

// Payload 3.90 pinta `beforeDocumentControls` de un global desde `admin.components.elements`,
// no desde `edit` como en las colecciones.
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

// Las del proyecto ganan: así puede retocar un texto del drawer sin perder los demás.
const mergeLanguage = (
  current: Record<string, unknown> | undefined,
  ours: { translator: Record<string, string> },
): Record<string, unknown> => ({
  ...current,
  translator: {
    ...ours.translator,
    ...(current?.translator as Record<string, unknown> | undefined),
  },
})

const mergeTranslations = (
  config: Config,
): NonNullable<Config['i18n']>['translations'] => {
  const current = (config.i18n?.translations ?? {}) as Translations
  return {
    ...current,
    es: mergeLanguage(current.es, translatorTranslations.es),
    en: mergeLanguage(current.en, translatorTranslations.en),
  } as NonNullable<Config['i18n']>['translations']
}

const schedulesQueue = async (payload: Payload, queue: string): Promise<boolean> => {
  const autoRun = payload.config.jobs.autoRun
  const entries = typeof autoRun === 'function' ? await autoRun(payload) : (autoRun ?? [])
  return entries.some(
    entry => entry.allQueues === true || (entry.queue ?? 'default') === queue,
  )
}

// Un error reintentable deja el job esperando su `waitUntil` y el registro en `queued`;
// sin nadie que vuelva a lanzar la cola, ese reintento no llega nunca. Solo se avisa:
// en E2E o en serverless puede ser deliberado.
const warnIfQueueUnscheduled = async (payload: Payload, queue: string): Promise<void> => {
  if (await schedulesQueue(payload, queue)) return
  payload.logger.warn(
    `translatorPlugin: ninguna entrada de \`jobs.autoRun\` procesa la cola "${queue}". Los reintentos de una traducción fallida no se ejecutarán hasta que algo vuelva a lanzar la cola (por ejemplo \`autoRun: [{ cron: '* * * * *', queue: '${queue}' }]\` o un cron externo).`,
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
        await warnIfQueueUnscheduled(payload, settings.queue)
      },
      collections: [
        ...(config.collections ?? []).map(collection =>
          settings.collections[collection.slug]
            ? withControl({ collection, blocks: config.blocks ?? [] })
            : collection,
        ),
        recordsCollection(settings.access),
      ],
      globals: (config.globals ?? []).map(global =>
        settings.globals[global.slug]
          ? withGlobalControl({ global, blocks: config.blocks ?? [] })
          : global,
      ),
      endpoints: [...(config.endpoints ?? []), ...translatorEndpoints(settings)],
      jobs: {
        ...config.jobs,
        // La clave de concurrencia de la tarea solo cuenta con esto activo; añade la
        // columna indexada `concurrencyKey` a la colección de jobs (migración en el
        // proyecto). Se respeta un `false` explícito del proyecto.
        enableConcurrencyControl: config.jobs?.enableConcurrencyControl ?? true,
        tasks: [...(config.jobs?.tasks ?? []), translateTask(settings)],
      },
      i18n: { ...config.i18n, translations: mergeTranslations(config) },
    }
  }
