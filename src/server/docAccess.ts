import type { PayloadRequest, SanitizedGlobalConfig } from 'payload'
import { docAccessOperation, docAccessOperationGlobal } from 'payload'

import type { EntityRef } from './entity.js'

export type DocPermissions = { read: boolean; update: boolean }

const NONE: DocPermissions = { read: false, update: false }

// Pasar `access` del plugin da derecho a usar el traductor, no a tocar cualquier
// documento: lo que decide por documento es el `access` de su colección o global, con el
// usuario de la petición, igual que hace el admin. `docAccessOperation` lee el documento
// y resuelve también los `access` que devuelven un `where`.
export const docPermissions = async ({
  req,
  ref,
}: {
  req: PayloadRequest
  ref: EntityRef
}): Promise<DocPermissions> => {
  if (ref.entityType === 'global') {
    const globalConfig = (
      req.payload.globals.config as unknown as SanitizedGlobalConfig[]
    ).find(item => item.slug === ref.collectionSlug)
    if (!globalConfig) return NONE
    const result = await docAccessOperationGlobal({ req, globalConfig })
    return { read: result.read === true, update: result.update === true }
  }
  const collection = req.payload.collections[ref.collectionSlug]
  if (!collection) return NONE
  const result = await docAccessOperation({ req, collection, id: ref.docId })
  return { read: result.read === true, update: result.update === true }
}
