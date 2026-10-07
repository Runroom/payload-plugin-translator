import type { CollectionConfig, Payload } from 'payload'

import type { FieldHashes } from '../core/plan.js'
import type { EntityRef } from './entity.js'

export const RECORDS_SLUG = 'translation-records'

export type RecordKey = EntityRef & { targetLocale: string }

export type TranslationRecord = {
  id: string
  status: 'queued' | 'running' | 'done' | 'failed'
  // Locale it was last translated from; the `fields` fingerprints are of that text.
  sourceLocale?: string | null
  fields: FieldHashes | null
  kept: string[] | null
  error: string | null
  translatedAt: string | null
  revalidatedAt?: string | null
  updatedAt: string
}

// Only the plugin touches the records, through the Local API, which skips `access`. Over
// REST and GraphQL nobody may create, change or delete one (that would bypass the lock or
// forge the fingerprints), nor read one: a record names a document and keeps its errors,
// and the plugin's `access` knows nothing of the document's own. `GET /status` is the way
// in, and it checks both.
const DENY = (): boolean => false

export const recordsCollection = (): CollectionConfig => {
  return {
    slug: RECORDS_SLUG,
    labels: {
      singular: { en: 'Translation record', es: 'Registro de traducción' },
      plural: { en: 'Translation records', es: 'Registros de traducción' },
    },
    admin: { hidden: true },
    access: { read: DENY, create: DENY, update: DENY, delete: DENY },
    indexes: [
      { fields: ['entityType', 'collectionSlug', 'docId', 'targetLocale'], unique: true },
    ],
    fields: [
      // For a global, `collectionSlug` holds the global's slug and `docId` is fixed.
      {
        name: 'entityType',
        type: 'select',
        required: true,
        defaultValue: 'collection',
        options: ['collection', 'global'],
      },
      { name: 'collectionSlug', type: 'text', required: true, index: true },
      { name: 'docId', type: 'text', required: true, index: true },
      { name: 'targetLocale', type: 'text', required: true },
      { name: 'sourceLocale', type: 'text' },
      {
        name: 'status',
        type: 'select',
        required: true,
        defaultValue: 'queued',
        options: ['queued', 'running', 'done', 'failed'],
      },
      { name: 'fields', type: 'json' },
      { name: 'kept', type: 'json' },
      { name: 'error', type: 'textarea' },
      { name: 'translatedAt', type: 'date' },
      // When the website was told about a translation written without drafts (`onLiveWrite`).
      { name: 'revalidatedAt', type: 'date' },
    ],
  }
}

const whereEntity = ({
  entityType,
  collectionSlug,
  docId,
}: EntityRef): Record<string, unknown>[] => [
  { entityType: { equals: entityType } },
  { collectionSlug: { equals: collectionSlug } },
  { docId: { equals: docId } },
]

const whereKey = (key: RecordKey): Record<string, unknown> => ({
  and: [...whereEntity(key), { targetLocale: { equals: key.targetLocale } }],
})

export const findRecord = async (
  payload: Payload,
  key: RecordKey,
): Promise<TranslationRecord | null> => {
  const { docs } = await payload.find({
    collection: RECORDS_SLUG as never,
    where: whereKey(key) as never,
    limit: 1,
    depth: 0,
  })
  return (docs[0] as unknown as TranslationRecord | undefined) ?? null
}

export const findRecords = async (
  payload: Payload,
  ref: EntityRef,
): Promise<(TranslationRecord & { targetLocale: string })[]> => {
  const { docs } = await payload.find({
    collection: RECORDS_SLUG as never,
    where: { and: whereEntity(ref) } as never,
    limit: 50,
    depth: 0,
  })
  return docs as unknown as (TranslationRecord & { targetLocale: string })[]
}

const updateRecord = async (
  payload: Payload,
  id: string,
  data: object,
): Promise<void> => {
  await payload.update({
    collection: RECORDS_SLUG as never,
    id,
    data: data as never,
  })
}

export const markRevalidated = (
  payload: Payload,
  { id, revalidatedAt }: { id: string; revalidatedAt: string },
): Promise<void> => updateRecord(payload, id, { revalidatedAt })

export const saveRecord = async (
  payload: Payload,
  {
    key,
    data,
  }: {
    key: RecordKey
    data: Partial<Omit<TranslationRecord, 'id' | 'updatedAt'>>
  },
): Promise<void> => {
  const existing = await findRecord(payload, key)
  if (existing) {
    await updateRecord(payload, existing.id, data)
    return
  }
  try {
    await payload.create({
      collection: RECORDS_SLUG as never,
      data: { ...key, ...data } as never,
    })
  } catch (error) {
    // The unique index rejects the create if another process got in between the lookup
    // and the write; in that case updating its record is enough.
    const winner = await findRecord(payload, key)
    if (!winner) throw error
    await updateRecord(payload, winner.id, data)
  }
}
