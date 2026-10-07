import { randomUUID } from 'node:crypto'
import type { CollectionConfig, Payload } from 'payload'
import { ValidationError } from 'payload'

import type { EntityRef } from './entity.js'
import { BUSY_WINDOW_MS } from './limits.js'

/**
 * Slug of the hidden collection that holds one lock per entity while a translation job is
 * queued or running. Closed over REST and GraphQL like the records.
 */
export const LOCKS_SLUG = 'translation-locks'

type Lock = { id: string; token: string; updatedAt: string }

const DENY = (): boolean => false

// The unique index on the entity key is what makes the lock atomic: of two simultaneous
// `create` calls the database accepts one and rejects the other with a unique violation,
// whatever the adapter, without a read-then-write window. `updatedAt` is the heartbeat; a
// lock nobody refreshed for the busy window (a process that died) can be taken over.
export const locksCollection = (): CollectionConfig => ({
  slug: LOCKS_SLUG,
  labels: {
    singular: { en: 'Translation lock', es: 'Bloqueo de traducción' },
    plural: { en: 'Translation locks', es: 'Bloqueos de traducción' },
  },
  admin: { hidden: true },
  access: { read: DENY, create: DENY, update: DENY, delete: DENY },
  indexes: [{ fields: ['entityType', 'collectionSlug', 'docId'], unique: true }],
  fields: [
    {
      name: 'entityType',
      type: 'select',
      required: true,
      defaultValue: 'collection',
      options: ['collection', 'global'],
    },
    { name: 'collectionSlug', type: 'text', required: true },
    { name: 'docId', type: 'text', required: true },
    // Identifies the holder: a job only touches a lock whose token it was given.
    { name: 'token', type: 'text', required: true },
  ],
})

export const isLiveLock = (lock: Pick<Lock, 'updatedAt'>): boolean =>
  Date.now() - Date.parse(lock.updatedAt) < BUSY_WINDOW_MS

const whereEntity = ({
  entityType,
  collectionSlug,
  docId,
}: EntityRef): Record<string, unknown>[] => [
  { entityType: { equals: entityType } },
  { collectionSlug: { equals: collectionSlug } },
  { docId: { equals: docId } },
]

const whereHeld = (ref: EntityRef, token: string): Record<string, unknown> => ({
  and: [...whereEntity(ref), { token: { equals: token } }],
})

/** The entity's lock, whoever holds it; `null` when the document is not locked. */
export const findLock = async (
  payload: Payload,
  ref: EntityRef,
): Promise<Lock | null> => {
  const { docs } = await payload.find({
    collection: LOCKS_SLUG as never,
    where: { and: whereEntity(ref) } as never,
    limit: 1,
    depth: 0,
  })
  return (docs[0] as unknown as Lock | undefined) ?? null
}

// The adapters turn a unique violation into a `ValidationError`; the data is complete, so
// nothing else makes the create invalid.
const tryCreate = async (
  payload: Payload,
  ref: EntityRef,
  token: string,
): Promise<boolean> => {
  try {
    await payload.create({
      collection: LOCKS_SLUG as never,
      data: { ...ref, token } as never,
    })
    return true
  } catch (error) {
    if (error instanceof ValidationError) return false
    throw error
  }
}

// Deleting by id and token means two takers of the same expired lock cannot both delete:
// the second delete finds nothing, and the fresh lock the first one creates has another
// id and token. The age filter keeps a lock its holder refreshed since `findLock` read
// it: Payload's `delete` with a `where` is a find followed by a delete by id, so a
// heartbeat that lands between those two steps can still be lost. That window is the
// milliseconds between two queries, not the time since the lookup.
const deleteExpired = async (payload: Payload, lock: Lock): Promise<void> => {
  const expiredBefore = new Date(Date.now() - BUSY_WINDOW_MS).toISOString()
  await payload.delete({
    collection: LOCKS_SLUG as never,
    where: {
      and: [
        { id: { equals: lock.id } },
        { token: { equals: lock.token } },
        { updatedAt: { less_than: expiredBefore } },
      ],
    } as never,
  })
}

const takeOver = async (
  payload: Payload,
  ref: EntityRef,
  token: string,
): Promise<boolean> => {
  const existing = await findLock(payload, ref)
  if (existing) {
    if (isLiveLock(existing)) return false
    await deleteExpired(payload, existing)
  }
  return tryCreate(payload, ref, token)
}

/** Takes the entity's lock; the token identifies the holder. `null` when someone else holds it. */
export const acquireLock = async (
  payload: Payload,
  ref: EntityRef,
): Promise<string | null> => {
  const token = randomUUID()
  if (await tryCreate(payload, ref, token)) return token
  return (await takeOver(payload, ref, token)) ? token : null
}

// The heartbeat: Payload stamps `updatedAt` on every update. A lock taken over since has
// another token, so the conditional update touches nothing and reports the loss.
export const refreshLock = async (
  payload: Payload,
  ref: EntityRef,
  token: string,
): Promise<boolean> => {
  const { docs } = await payload.update({
    collection: LOCKS_SLUG as never,
    where: whereHeld(ref, token) as never,
    data: { token } as never,
    depth: 0,
  })
  return docs.length > 0
}

export const releaseLock = async (
  payload: Payload,
  ref: EntityRef,
  token: string,
): Promise<void> => {
  await payload.delete({
    collection: LOCKS_SLUG as never,
    where: whereHeld(ref, token) as never,
  })
}
