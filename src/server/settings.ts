import type { PayloadRequest } from 'payload'

import type { TranslationProvider } from '../provider/types.js'
import type { EntityRef } from './entity.js'
import type { OnLiveWrite } from './liveWrites.js'

export type TranslatorAccessOperation = 'translate' | 'status'

// `ref` and `operation` are extras: a function that only looks at `req` keeps working.
// There is no `ref` when deciding access to the records collection, which belongs to no
// document.
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
