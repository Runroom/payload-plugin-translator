import type { Config } from 'payload'

import { en } from './en.js'
import { es } from './es.js'

// The admin strings the plugin ships, by language. Spread them into
// `i18n.translations` to tweak a text or to add a language.
export const translatorTranslations = { en, es }

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
