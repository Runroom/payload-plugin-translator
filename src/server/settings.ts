import type { PayloadRequest } from 'payload'

import type { TranslationProvider } from '../provider/types.js'
import type { OnLiveWrite } from './liveWrites.js'

export type TranslatorAccess = (args: {
  req: PayloadRequest
}) => boolean | Promise<boolean>

// Idiomas entre los que se traduce la entidad: el abierto en el admin hace de origen y los
// demás, de destino.
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
