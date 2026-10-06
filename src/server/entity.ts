import type { Field, Payload } from 'payload'

import { TRANSLATOR_WRITE_CONTEXT } from '../context.js'
import type { EntityLocales, TranslatorSettings } from './settings.js'

type EntityType = 'collection' | 'global'

// Un global no tiene documentos: sus registros y su job llevan este id fijo para que la
// clave sea la misma que la de un documento de colección.
export const GLOBAL_DOC_ID = 'global'

export type EntityRef = { entityType: EntityType; collectionSlug: string; docId: string }

type Doc = Record<string, unknown>

type ReadArgs = { locale: string; withFallback: boolean }

export type Entity = {
  fields: Field[]
  writesLive: boolean
  read: (args: ReadArgs) => Promise<Doc>
  find: (args: { locale: string }) => Promise<Doc | null>
  // Devuelve el documento tal como quedó guardado: un hook `beforeChange` puede
  // reescribir lo que se mandó (un `formatSlug`), y las huellas tienen que ser de eso.
  write: (args: { locale: string; data: Doc }) => Promise<Doc>
  // Fecha de la última versión publicada; `null` sin borradores o si nunca se publicó.
  lastPublishedAt: () => Promise<string | null>
}

// Un id que el adaptador no puede ni interpretar (no UUID en Postgres, no ObjectID en
// Mongo) no es un error del servidor: el documento no existe. SQLite guarda el id como
// texto y ya responde «no encontrado» por sí mismo.
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

// Sin borradores no hay dónde dejar la traducción pendiente de revisar: `draft: true`
// publicaría igual. Se omite para que la llamada diga lo que hace, y `/status` lo expone
// como `writesLive` para que el drawer avise antes de traducir.
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

// El plugin ya exige `localization` al arrancar; aquí solo se cumple el tipo.
export const defaultLocaleOf = (payload: Payload): string => {
  const localization = payload.config.localization
  if (!localization)
    throw new Error('translatorPlugin necesita `localization` en la config')
  return localization.defaultLocale
}

// `null` cuando la colección o el global no están registrados en Payload.
export const entityOf = (payload: Payload, ref: EntityRef): Entity | null =>
  ref.entityType === 'global'
    ? globalEntity(payload, ref)
    : collectionEntity(payload, ref)

export const localesOf = (
  settings: TranslatorSettings,
  ref: Pick<EntityRef, 'entityType' | 'collectionSlug'>,
): EntityLocales | undefined =>
  ref.entityType === 'global'
    ? settings.globals[ref.collectionSlug]
    : settings.collections[ref.collectionSlug]
