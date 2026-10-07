import type {
  Payload,
  PayloadRequest,
  SanitizedFieldsPermissions,
  SanitizedGlobalConfig,
  TypedUser,
} from 'payload'
import { createLocalReq, docAccessOperation, docAccessOperationGlobal } from 'payload'

import { mergeFieldPermissions } from '../core/permissions.js'
import type { EntityRef } from './entity.js'
import { AccessDeniedError } from './errors.js'

export type DocPermissions = {
  read: boolean
  update: boolean
  fields: SanitizedFieldsPermissions
}

const NONE: DocPermissions = { read: false, update: false, fields: {} }

// Access rules may depend on `req.locale`, and `docAccessOperation` reads the document in
// that locale before handing it to them. The request is restored afterwards: a real
// request cannot be cloned, since `headers` and friends live on the `Request` prototype.
// That read goes through `createLocalReq`, which also rewrites `req.fallbackLocale`.
const withLocale = async <T>(
  req: PayloadRequest,
  locale: string,
  work: () => Promise<T>,
): Promise<T> => {
  const previous = { locale: req.locale, fallbackLocale: req.fallbackLocale }
  req.locale = locale
  try {
    return await work()
  } finally {
    req.locale = previous.locale
    req.fallbackLocale = previous.fallbackLocale
  }
}

const resolve = async (req: PayloadRequest, ref: EntityRef): Promise<DocPermissions> => {
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

// The plugin's `access` only grants use of the translator, not access to any document.
// Each document is governed by the `access` of its collection or global, evaluated with the
// request's user as the admin does, in the given locale. `docAccessOperation` reads the
// document, so it also resolves `access` functions that return a `where`.
export const docPermissions = ({
  req,
  ref,
  locale,
}: {
  req: PayloadRequest
  ref: EntityRef
  locale: string
}): Promise<DocPermissions> => withLocale(req, locale, () => resolve(req, ref))

const permissionsAs = async ({
  payload,
  user,
  ref,
  locale,
}: {
  payload: Payload
  user: TypedUser
  ref: EntityRef
  locale: string
}): Promise<DocPermissions> =>
  docPermissions({ req: await createLocalReq({ user, locale }, payload), ref, locale })

// What the requester may translate between two locales, decided when the job runs rather
// than when it was queued: the source must be readable in its locale and the target
// updatable in its own. The field permissions come from the same two checks. Throws
// `AccessDeniedError` when either is missing.
export const requesterPermissions = async ({
  payload,
  user,
  ref,
  sourceLocale,
  targetLocale,
}: {
  payload: Payload
  user: TypedUser
  ref: EntityRef
  sourceLocale: string
  targetLocale: string
}): Promise<SanitizedFieldsPermissions> => {
  const [source, target] = await Promise.all([
    permissionsAs({ payload, user, ref, locale: sourceLocale }),
    permissionsAs({ payload, user, ref, locale: targetLocale }),
  ])
  if (!source.read || !target.update) throw new AccessDeniedError('Access denied')
  return mergeFieldPermissions(source.fields, target.fields)
}
