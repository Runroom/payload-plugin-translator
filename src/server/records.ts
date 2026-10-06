import type { CollectionConfig, Payload } from 'payload'

import type { FieldHashes } from '../core/plan.js'
import type { EntityRef } from './entity.js'
import type { TranslatorAccess } from './settings.js'

export const RECORDS_SLUG = 'translation-records'

export type RecordKey = EntityRef & { targetLocale: string }

export type TranslationRecord = {
  id: string
  status: 'queued' | 'running' | 'done' | 'failed'
  // Idioma desde el que se tradujo la última vez; las huellas de `fields` son de ese texto.
  sourceLocale?: string | null
  fields: FieldHashes | null
  kept: string[] | null
  error: string | null
  translatedAt: string | null
  revalidatedAt?: string | null
  updatedAt: string
}

export const recordsCollection = (access: TranslatorAccess): CollectionConfig => {
  const allowed = ({
    req,
  }: {
    req: Parameters<TranslatorAccess>[0]['req']
  }): Promise<boolean> => Promise.resolve(access({ req }))
  return {
    slug: RECORDS_SLUG,
    labels: { singular: 'Registro de traducción', plural: 'Registros de traducción' },
    admin: { hidden: true },
    access: { read: allowed, create: allowed, update: allowed, delete: allowed },
    indexes: [
      { fields: ['entityType', 'collectionSlug', 'docId', 'targetLocale'], unique: true },
    ],
    fields: [
      // Con un global, `collectionSlug` guarda el slug del global y `docId` es fijo.
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
      // Cuándo se avisó a la web de una traducción escrita sin borradores (`onLiveWrite`).
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
    // El índice único rechaza el create si otro proceso se adelantó entre la
    // búsqueda y la escritura; en ese caso basta con actualizar el suyo.
    const winner = await findRecord(payload, key)
    if (!winner) throw error
    await updateRecord(payload, winner.id, data)
  }
}
