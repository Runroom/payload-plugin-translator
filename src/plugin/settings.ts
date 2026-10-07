import type { Config } from 'payload'

import type { TranslationProvider } from '../provider/types.js'
import type { OnLiveWrite } from '../server/liveWrites.js'
import type {
  EntityLocales,
  TranslatorAccess,
  TranslatorSettings,
} from '../server/settings.js'
import { localizationOf } from '../server/settings.js'

/**
 * Options for one collection or global. `locales` are the locales the entity is translated
 * between; they must exist in `localization`, be at least two, and default to every locale
 * in `localization`.
 */
export type TranslatorEntityOptions = { locales?: string[] }

type EntityOptions = Record<string, TranslatorEntityOptions>

/** Options for `translatorPlugin`. */
export type TranslatorPluginOptions = {
  /** Collections to translate, by slug. `{}` is enough in the usual case. */
  collections: EntityOptions
  /**
   * Globals to translate, by slug, with the same shape as `collections`.
   * @default {}
   */
  globals?: EntityOptions
  /**
   * The translation backend. With `null` the plugin registers the same schema and still
   * reports status, but hides the button and answers `POST /translate` with 503. Use it to
   * run without an API key.
   */
  provider: TranslationProvider | null
  /**
   * Extra instructions for the model (context, tone, terminology), appended to the
   * provider's own prompt.
   * @default () => ''
   */
  instructions?: (args: { sourceLocale: string; targetLocale: string }) => string
  /** Decides who may use the translator endpoints. */
  access: TranslatorAccess
  /**
   * Jobs queue the translation jobs go to. Make sure `jobs.autoRun` or an external cron
   * processes it, or retries never run.
   * @default 'translations'
   */
  queue?: string
  /**
   * Whether `POST /translate` runs the job it queued right away, without waiting for it,
   * so the translation starts as soon as the request is answered. That needs a Node
   * process that outlives the response. On serverless, where the function can be frozen
   * or killed after Payload marked the job as processing, set it to `false`: the request
   * then only queues the job, and `jobs.autoRun` or an external cron hitting Payload's
   * jobs run endpoint processes the queue.
   * @default true
   */
  runOnRequest?: boolean
  /**
   * Called after a translation of an entity without drafts is written, so you can
   * revalidate the public site. It runs from `GET /status`, not from the job.
   */
  onLiveWrite?: OnLiveWrite
}

const localeCodesOf = (config: Config): string[] =>
  localizationOf(config).locales.map(locale =>
    typeof locale === 'string' ? locale : locale.code,
  )

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

export const resolveSettings = (
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
  runOnRequest: options.runOnRequest ?? true,
  onLiveWrite: options.onLiveWrite,
})
