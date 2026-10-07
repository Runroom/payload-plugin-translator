import type { Config, PayloadRequest } from 'payload'

import type { TranslationProvider } from '../provider/types.js'
import type { EntityRef } from './entity.js'
import type { OnLiveWrite } from './liveWrites.js'

/**
 * The endpoint an `access` call is for: `'translate'` for `POST /translate`, `'status'`
 * for `GET /status`.
 */
export type TranslatorAccessOperation = 'translate' | 'status'

/**
 * Decides who may use the translator endpoints; returning `false` answers 403. The
 * endpoints sit outside Payload's collection access control, so put every check you need
 * here. The document's own read and update access is checked separately. `ref` is absent
 * when the status query names no valid entity.
 */
export type TranslatorAccess = (args: {
  req: PayloadRequest
  ref?: EntityRef
  operation: TranslatorAccessOperation
}) => boolean | Promise<boolean>

// Locales the entity is translated between. The one open in the admin is the source and
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

// `localization` is optional in Payload's config, but the translator cannot work without
// it.
export const localizationOf = (config: {
  localization?: Config['localization']
}): Exclude<Config['localization'], false | undefined> => {
  const { localization } = config
  if (!localization)
    throw new Error('translatorPlugin requires `localization` in the config')
  return localization
}
