import type { Field, Payload, TypedUser } from 'payload'

import { TRANSLATOR_WRITE_CONTEXT } from '../context.js'
import type { EntityLocales, TranslatorSettings } from './settings.js'
import { localizationOf } from './settings.js'
import type { TransactionID } from './transaction.js'

type EntityType = 'collection' | 'global'

// A global has no document id, so its records and jobs use this fixed one to keep the
// same key shape as a collection document.
export const GLOBAL_DOC_ID = 'global'

/**
 * Identifies a collection document or a global. For a global, `collectionSlug` holds the
 * global's slug and `docId` is the fixed value `'global'`.
 */
export type EntityRef = { entityType: EntityType; collectionSlug: string; docId: string }

type Doc = Record<string, unknown>

// With `transactionID` the call joins that Payload transaction instead of running alone.
type Transactional = { transactionID?: TransactionID }

// `asStored` reads what Payload stored, without the requester's access rules. It is for
// the target side only: those reads are compared with what was planned or sent, and never
// reach the requester or the provider.
type ReadArgs = Transactional & {
  locale: string
  withFallback: boolean
  asStored?: boolean
}

export type Entity = {
  fields: Field[]
  writesLive: boolean
  // As the requester unless `asStored`, so a field they may update but not read in the
  // target still shows what it holds.
  read: (args: ReadArgs) => Promise<Doc>
  find: (args: { locale: string }) => Promise<Doc | null>
  write: (args: Transactional & { locale: string; data: Doc }) => Promise<void>
  // Date of the latest published version; `null` without drafts or if never published.
  lastPublishedAt: () => Promise<string | null>
}

// An id the adapter cannot parse (not a UUID in Postgres, not an ObjectID in Mongo) means
// the document does not exist, not a server error. SQLite stores ids as text and already
// answers "not found" on its own.
const INVALID_ID_CODES = new Set(['22P02'])

const isInvalidId = (error: unknown): boolean => {
  const failure = error as { code?: unknown; name?: unknown; cause?: unknown } | null
  if (!failure || typeof failure !== 'object') return false
  return (
    (typeof failure.code === 'string' && INVALID_ID_CODES.has(failure.code)) ||
    failure.name === 'CastError' ||
    (failure.cause !== undefined && isInvalidId(failure.cause))
  )
}

type EntityConfig = { fields: Field[]; versions?: unknown }

const hasDrafts = (config: EntityConfig): boolean => {
  const versions = config.versions as { drafts?: unknown } | false | undefined
  return typeof versions === 'object' && Boolean(versions.drafts)
}

// Without drafts there is nowhere to leave a translation pending review, and `draft: true`
// would publish anyway. The option is omitted so the call reflects what really happens;
// `/status` reports it as `writesLive` so the drawer warns before translating.
const draftOption = (drafts: boolean): { draft?: true } => (drafts ? { draft: true } : {})

const PUBLISHED = { 'version._status': { equals: 'published' } }

const LATEST_VERSION = { sort: '-updatedAt', limit: 1, depth: 0 } as const

const updatedAtOf = (result: unknown): string | null => {
  const [latest] = (result as { docs: { updatedAt?: unknown }[] }).docs
  return typeof latest?.updatedAt === 'string' ? latest.updatedAt : null
}

const fallbackOption = (withFallback: boolean): { fallbackLocale?: false } =>
  withFallback ? {} : { fallbackLocale: false }

// Payload joins an operation to a transaction through `req.transactionID`; the rest of the
// request is built by the Local API as usual.
export const transactionOption = (
  transactionID: TransactionID | undefined,
): { req?: { transactionID: TransactionID } } =>
  transactionID === undefined ? {} : { req: { transactionID } }

/** Who the entity is read and written as; without a user, with the Local API's default access. */
export type EntityOptions = { user?: TypedUser }

// With a user, Payload applies the collection, field and row access rules of that user to
// what is read (and so sent to the provider) and written. The plugin's own lookups (the
// existence check, the versions) keep the default access.
const accessOption = (
  user: TypedUser | undefined,
): { overrideAccess?: false; user?: TypedUser } =>
  user ? { overrideAccess: false, user } : {}

const readOptions = (
  { locale, withFallback, transactionID, asStored }: ReadArgs,
  user: TypedUser | undefined,
): Doc => ({
  locale,
  ...fallbackOption(withFallback),
  ...accessOption(asStored ? undefined : user),
  ...transactionOption(transactionID),
  // As on the writes, so read access rules can tell the translator apart.
  context: { ...TRANSLATOR_WRITE_CONTEXT },
})

const collectionEntity = (
  payload: Payload,
  { collectionSlug, docId }: EntityRef,
  { user }: EntityOptions,
): Entity | null => {
  const registered = payload.collections as unknown as Record<
    string,
    { config: EntityConfig } | undefined
  >
  const config = registered[collectionSlug]?.config
  if (!config) return null
  const drafts = hasDrafts(config)
  const findByID = (args: Doc): Promise<unknown> =>
    payload.findByID({
      collection: collectionSlug as never,
      id: docId,
      depth: 0,
      ...draftOption(drafts),
      ...args,
    } as never)
  return {
    fields: config.fields,
    writesLive: !drafts,
    read: async args => (await findByID(readOptions(args, user))) as Doc,
    find: async ({ locale }) => {
      try {
        return (await findByID({ locale, disableErrors: true })) as Doc | null
      } catch (error) {
        if (isInvalidId(error)) return null
        throw error
      }
    },
    write: async ({ locale, data, transactionID }) => {
      await payload.update({
        collection: collectionSlug as never,
        id: docId,
        locale: locale as never,
        ...draftOption(drafts),
        ...accessOption(user),
        ...transactionOption(transactionID),
        depth: 0,
        data: data as never,
        context: { ...TRANSLATOR_WRITE_CONTEXT },
      })
    },
    lastPublishedAt: async () =>
      drafts
        ? updatedAtOf(
            await payload.findVersions({
              collection: collectionSlug as never,
              where: { and: [{ parent: { equals: docId } }, PUBLISHED] },
              ...LATEST_VERSION,
            }),
          )
        : null,
  }
}

const globalEntity = (
  payload: Payload,
  { collectionSlug: slug }: EntityRef,
  { user }: EntityOptions,
): Entity | null => {
  const configs = (
    payload.globals as unknown as { config: (EntityConfig & { slug: string })[] }
  ).config
  const config = configs.find(item => item.slug === slug)
  if (!config) return null
  const drafts = hasDrafts(config)
  const findGlobal = async (args: Doc): Promise<Doc> =>
    (await payload.findGlobal({
      slug: slug as never,
      depth: 0,
      ...draftOption(drafts),
      ...args,
    } as never)) as unknown as Doc
  return {
    fields: config.fields,
    writesLive: !drafts,
    read: args => findGlobal(readOptions(args, user)),
    find: ({ locale }) => findGlobal({ locale }),
    write: async ({ locale, data, transactionID }) => {
      await payload.updateGlobal({
        slug: slug as never,
        locale: locale as never,
        ...draftOption(drafts),
        ...accessOption(user),
        ...transactionOption(transactionID),
        depth: 0,
        data: data as never,
        context: { ...TRANSLATOR_WRITE_CONTEXT },
      } as never)
    },
    lastPublishedAt: async () =>
      drafts
        ? updatedAtOf(
            await payload.findGlobalVersions({
              slug: slug as never,
              where: PUBLISHED,
              ...LATEST_VERSION,
            }),
          )
        : null,
  }
}

// The plugin already requires `localization` at startup; this only satisfies the type.
export const defaultLocaleOf = (payload: Payload): string => {
  return localizationOf(payload.config).defaultLocale
}

// `null` when the collection or the global is not registered in Payload.
export const entityOf = (
  payload: Payload,
  ref: EntityRef,
  options: EntityOptions = {},
): Entity | null =>
  ref.entityType === 'global'
    ? globalEntity(payload, ref, options)
    : collectionEntity(payload, ref, options)

// The source is the locale open in the admin; the targets are the requested locales of
// the entity other than the source.
export const targetLocalesOf = ({
  locales,
  sourceLocale,
  requested,
}: {
  locales: string[]
  sourceLocale: string
  requested: string[]
}): string[] =>
  requested.filter(locale => locales.includes(locale) && locale !== sourceLocale)

export const localesOf = (
  settings: TranslatorSettings,
  ref: Pick<EntityRef, 'entityType' | 'collectionSlug'>,
): EntityLocales | undefined =>
  ref.entityType === 'global'
    ? settings.globals[ref.collectionSlug]
    : settings.collections[ref.collectionSlug]
