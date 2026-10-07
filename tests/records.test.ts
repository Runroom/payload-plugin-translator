import type { Payload } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import {
  findRecords,
  RECORDS_SLUG,
  recordsCollection,
  saveRecord,
} from '../src/server/records.js'

const key = {
  entityType: 'collection' as const,
  collectionSlug: 'events',
  docId: 'e1',
  targetLocale: 'ca',
}

const fakePayload = ({
  finds,
  create,
}: {
  finds: unknown[][]
  create: ReturnType<typeof vi.fn>
}): { payload: Payload; update: ReturnType<typeof vi.fn> } => {
  const update = vi.fn().mockResolvedValue({})
  const find = vi.fn()
  for (const docs of finds) find.mockResolvedValueOnce({ docs })
  return { payload: { find, create, update } as unknown as Payload, update }
}

describe('saveRecord', () => {
  it('updates the record another process created between the lookup and the create', async () => {
    const create = vi.fn().mockRejectedValue(new Error('unique violation'))
    const { payload, update } = fakePayload({ finds: [[], [{ id: 'r1' }]], create })

    await saveRecord(payload, { key, data: { status: 'running' } })

    expect(update).toHaveBeenCalledWith({
      collection: RECORDS_SLUG,
      id: 'r1',
      data: { status: 'running' },
    })
  })

  it('rethrows the create error when the record still does not exist', async () => {
    const failure = new Error('db down')
    const create = vi.fn().mockRejectedValue(failure)
    const { payload } = fakePayload({ finds: [[], []], create })

    await expect(saveRecord(payload, { key, data: { status: 'running' } })).rejects.toBe(
      failure,
    )
  })
})

describe('records of a global', () => {
  const globalKey = {
    entityType: 'global' as const,
    collectionSlug: 'footer',
    docId: 'global',
    targetLocale: 'ca',
  }

  it('looks records up by entity type, so a global never matches a collection of the same slug', async () => {
    const create = vi.fn().mockResolvedValue({})
    const { payload } = fakePayload({ finds: [[]], create })

    await saveRecord(payload, { key: globalKey, data: { status: 'queued' } })

    expect(vi.mocked(payload.find).mock.calls[0]![0].where).toEqual({
      and: [
        { entityType: { equals: 'global' } },
        { collectionSlug: { equals: 'footer' } },
        { docId: { equals: 'global' } },
        { targetLocale: { equals: 'ca' } },
      ],
    })
    expect(create).toHaveBeenCalledWith({
      collection: RECORDS_SLUG,
      data: { ...globalKey, status: 'queued' },
    })
  })

  it('lists the records of one entity only', async () => {
    const { payload } = fakePayload({ finds: [[]], create: vi.fn() })

    await findRecords(payload, {
      entityType: 'global',
      collectionSlug: 'footer',
      docId: 'global',
    })

    expect(vi.mocked(payload.find).mock.calls[0]![0].where).toEqual({
      and: [
        { entityType: { equals: 'global' } },
        { collectionSlug: { equals: 'footer' } },
        { docId: { equals: 'global' } },
      ],
    })
  })

  it('keys the unique index on the entity type too', () => {
    const collection = recordsCollection()
    const entityType = collection.fields.find(
      field => 'name' in field && field.name === 'entityType',
    )

    expect(collection.indexes).toEqual([
      { fields: ['entityType', 'collectionSlug', 'docId', 'targetLocale'], unique: true },
    ])
    expect(entityType).toMatchObject({
      type: 'select',
      required: true,
      defaultValue: 'collection',
      options: ['collection', 'global'],
    })
  })
})

describe('records collection access', () => {
  const collection = recordsCollection()
  const req = { user: { id: 'u1' } } as never
  type AccessFn = (args: { req: never }) => boolean | Promise<boolean>

  it('never lets REST or GraphQL read, create, update or delete a record', async () => {
    for (const operation of ['read', 'create', 'update', 'delete'] as const) {
      expect(await (collection.access![operation] as AccessFn)({ req })).toBe(false)
    }
  })
})
