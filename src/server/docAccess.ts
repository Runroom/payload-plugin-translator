import type {
  PayloadRequest,
  SanitizedFieldsPermissions,
  SanitizedGlobalConfig,
} from 'payload'
import { docAccessOperation, docAccessOperationGlobal } from 'payload'

import type { EntityRef } from './entity.js'

export type DocPermissions = {
  read: boolean
  update: boolean
  fields: SanitizedFieldsPermissions
}

const NONE: DocPermissions = { read: false, update: false, fields: {} }

// Passing the plugin's `access` grants the right to use the translator, not to touch any
// document: what decides per document is the `access` of its collection or global, with
// the request's user, just as the admin does. `docAccessOperation` reads the document and
// also resolves the `access` functions that return a `where`.
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
    return {
      read: result.read === true,
      update: result.update === true,
      fields: result.fields,
    }
  }
  const collection = req.payload.collections[ref.collectionSlug]
  if (!collection) return NONE
  const result = await docAccessOperation({ req, collection, id: ref.docId })
  return {
    read: result.read === true,
    update: result.update === true,
    fields: result.fields,
  }
}
