import type { Config } from 'payload'

import type { TranslationProvider } from '../provider/types.js'
import type { OnLiveWrite } from '../server/liveWrites.js'
import type {
  EntityLocales,
  TranslatorAccess,
  TranslatorSettings,
} from '../server/settings.js'
import { localizationOf } from '../server/settings.js'

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
  onLiveWrite: options.onLiveWrite,
})
