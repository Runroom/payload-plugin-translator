import type { Field, Payload } from 'payload'

import { TRANSLATOR_WRITE_CONTEXT } from '../context.js'
import type { EntityLocales, TranslatorSettings } from './settings.js'
import { localizationOf } from './settings.js'

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

type ReadArgs = { locale: string; withFallback: boolean }

export type Entity = {
  fields: Field[]
  writesLive: boolean
  read: (args: ReadArgs) => Promise<Doc>
  find: (args: { locale: string }) => Promise<Doc | null>
  // Returns the document as saved. A `beforeChange` hook (a `formatSlug`) can rewrite what
  // was sent, and the fingerprints must be taken from the saved value.
  write: (args: { locale: string; data: Doc }) => Promise<Doc>
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

const collectionEntity = (
  payload: Payload,
  { collectionSlug, docId }: EntityRef,
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
    read: async ({ locale, withFallback }) =>
      (await findByID({ locale, ...fallbackOption(withFallback) })) as Doc,
    find: async ({ locale }) => {
      try {
        return (await findByID({ locale, disableErrors: true })) as Doc | null
      } catch (error) {
        if (isInvalidId(error)) return null
        throw error
      }
    },
    write: async ({ locale, data }) =>
      (await payload.update({
        collection: collectionSlug as never,
        id: docId,
        locale: locale as never,
        ...draftOption(drafts),
        depth: 0,
        data: data as never,
        context: { ...TRANSLATOR_WRITE_CONTEXT },
      })) as unknown as Doc,
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
    read: ({ locale, withFallback }) =>
      findGlobal({ locale, ...fallbackOption(withFallback) }),
    find: ({ locale }) => findGlobal({ locale }),
    write: async ({ locale, data }) =>
      (await payload.updateGlobal({
        slug: slug as never,
        locale: locale as never,
        ...draftOption(drafts),
        depth: 0,
        data: data as never,
        context: { ...TRANSLATOR_WRITE_CONTEXT },
      } as never)) as unknown as Doc,
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
export const entityOf = (payload: Payload, ref: EntityRef): Entity | null =>
  ref.entityType === 'global'
    ? globalEntity(payload, ref)
    : collectionEntity(payload, ref)

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
