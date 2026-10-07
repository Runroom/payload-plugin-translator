import type { Config, PayloadRequest } from 'payload'

import type { TranslationProvider } from '../provider/types.js'
import type { EntityRef } from './entity.js'
import type { OnLiveWrite } from './liveWrites.js'

export type TranslatorAccessOperation = 'translate' | 'status'

// `ref` and `operation` are extras: a function that only looks at `req` keeps working.
// There is no `ref` when the status query names no valid entity.
export type TranslatorAccess = (args: {
  req: PayloadRequest
  ref?: EntityRef
  operation: TranslatorAccessOperation
}) => boolean | Promise<boolean>

// Locales the entity is translated between: the one open in the admin is the source and
// the others are the targets.
export type EntityLocales = { locales: string[] }

export type TranslatorSettings = {
  collections: Record<string, EntityLocales>
  globals: Record<string, EntityLocales>
  provider: TranslationProvider | null
  instructions: (args: { sourceLocale: string; targetLocale: string }) => string
  access: TranslatorAccess
  queue: string
  onLiveWrite?: OnLiveWrite
}

// `localization` is optional in Payload's config but the translator has nothing to do
// without it: this is the one place that says so.
export const localizationOf = (config: {
  localization?: Config['localization']
}): Exclude<Config['localization'], false | undefined> => {
  const { localization } = config
  if (!localization)
    throw new Error('translatorPlugin requires `localization` in the config')
  return localization
}
