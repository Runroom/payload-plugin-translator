import type { Config } from 'payload'

import { en } from './en.js'
import { es } from './es.js'

/**
 * The admin strings the plugin ships, by language, under the `translator` namespace.
 * `translatorTranslations.en.translator` lists every key; override single keys or add a
 * language through your own `i18n.translations`.
 */
export const translatorTranslations = { en, es }

type Translations = Record<string, Record<string, unknown>>

type Catalog = { translator: Record<string, string> }

// The project's strings win, so it can override one key and keep the rest.
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

// Every admin language gets the plugin's strings. A language without its own catalog falls
// back to English instead of showing the raw keys.
export const mergeTranslations = (
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
