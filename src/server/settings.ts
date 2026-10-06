import type { PayloadRequest } from 'payload'

import type { TranslationProvider } from '../provider/types.js'
import type { EntityRef } from './entity.js'
import type { OnLiveWrite } from './liveWrites.js'

export type TranslatorAccessOperation = 'translate' | 'status'

// `ref` y `operation` van a mayores: quien solo mire `req` sigue funcionando. Sin `ref`
// cuando se decide el acceso a la colección de registros, que no es de un documento.
export type TranslatorAccess = (args: {
  req: PayloadRequest
  ref?: EntityRef
  operation: TranslatorAccessOperation
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
