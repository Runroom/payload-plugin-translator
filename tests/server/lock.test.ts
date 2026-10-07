import type { Payload } from 'payload'
import { ValidationError } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import { BUSY_WINDOW_MS } from '../../src/server/limits.js'
import {
  acquireLock,
  isLiveLock,
  LOCKS_SLUG,
  locksCollection,
  refreshLock,
  releaseLock,
} from '../../src/server/lock.js'

const ref = { entityType: 'collection' as const, collectionSlug: 'events', docId: 'e1' }

const uniqueViolation = (): ValidationError =>
  new ValidationError({ collection: LOCKS_SLUG, errors: [] })

const lockAged = (ageMs: number, token = 'other'): Record<string, unknown> => ({
  id: 'l1',
  token,
  updatedAt: new Date(Date.now() - ageMs).toISOString(),
})

// `creates` answers each `create` in turn: `true` succeeds, `false` is a unique violation.
const fakePayload = ({
  creates,
  finds = [],
  updated = [],
}: {
  creates: boolean[]
  finds?: Record<string, unknown>[][]
  updated?: Record<string, unknown>[]
}): {
  payload: Payload
  create: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
} => {
  const create = vi.fn()
  for (const ok of creates) {
    if (ok) create.mockResolvedValueOnce({})
    else create.mockRejectedValueOnce(uniqueViolation())
  }
  const find = vi.fn()
  for (const docs of finds) find.mockResolvedValueOnce({ docs })
  const remove = vi.fn().mockResolvedValue({})
  const update = vi.fn().mockResolvedValue({ docs: updated, errors: [] })
  return {
    payload: { create, find, delete: remove, update } as unknown as Payload,
    create,
    remove,
    update,
  }
}

describe('locksCollection', () => {
  it('is hidden, closed to the API and unique per entity', () => {
    const collection = locksCollection()

    expect(collection.slug).toBe(LOCKS_SLUG)
    expect(collection.admin?.hidden).toBe(true)
    expect(collection.indexes).toEqual([
      { fields: ['entityType', 'collectionSlug', 'docId'], unique: true },
    ])
    expect(collection.fields.map(field => (field as { name: string }).name)).toEqual([
      'entityType',
      'collectionSlug',
      'docId',
      'token',
    ])
  })
})

describe('acquireLock', () => {
  it('creates the lock with a fresh token when nobody holds it', async () => {
    const { payload, create } = fakePayload({ creates: [true] })

    const token = await acquireLock(payload, ref)

    expect(token).toEqual(expect.any(String))
    expect(create).toHaveBeenCalledWith({
      collection: LOCKS_SLUG,
      data: { ...ref, token },
    })
  })

  it('answers busy when the existing lock is still alive', async () => {
    const { payload, remove } = fakePayload({
      creates: [false],
      finds: [[lockAged(BUSY_WINDOW_MS - 1_000)]],
    })

    expect(await acquireLock(payload, ref)).toBeNull()
    expect(remove).not.toHaveBeenCalled()
  })

  it('deletes an expired lock by id and token, only if still expired, and takes it over', async () => {
    const { payload, remove, create } = fakePayload({
      creates: [false, true],
      finds: [[lockAged(BUSY_WINDOW_MS + 1)]],
    })
    const before = Date.now()

    const token = await acquireLock(payload, ref)

    expect(token).toEqual(expect.any(String))
    expect(remove).toHaveBeenCalledWith({
      collection: LOCKS_SLUG,
      where: {
        and: [
          { id: { equals: 'l1' } },
          { token: { equals: 'other' } },
          { updatedAt: { less_than: expect.any(String) } },
        ],
      },
    })
    // A heartbeat that landed since the lookup moves `updatedAt` past the cutoff, so the
    // delete no longer matches a lock its holder is still using.
    const [{ where }] = remove.mock.calls[0] as [{ where: { and: unknown[] } }]
    const cutoff = Date.parse(
      (where.and[2] as { updatedAt: { less_than: string } }).updatedAt.less_than,
    )
    expect(cutoff).toBeGreaterThanOrEqual(before - BUSY_WINDOW_MS)
    expect(cutoff).toBeLessThanOrEqual(Date.now() - BUSY_WINDOW_MS)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('answers busy when another taker wins the race for an expired lock', async () => {
    const { payload } = fakePayload({
      creates: [false, false],
      finds: [[lockAged(BUSY_WINDOW_MS + 1)]],
    })

    expect(await acquireLock(payload, ref)).toBeNull()
  })

  it('tries once more when the lock vanished between the violation and the lookup', async () => {
    const { payload } = fakePayload({ creates: [false, true], finds: [[]] })

    expect(await acquireLock(payload, ref)).toEqual(expect.any(String))
  })

  it('rethrows an error that is not a unique violation', async () => {
    const create = vi.fn().mockRejectedValue(new Error('db down'))
    const payload = { create, find: vi.fn() } as unknown as Payload

    await expect(acquireLock(payload, ref)).rejects.toThrow('db down')
  })
})

describe('refreshLock and releaseLock', () => {
  it('refreshes only the lock that still carries the token and reports a lost one', async () => {
    const held = fakePayload({ creates: [], updated: [lockAged(0, 'mine')] })

    expect(await refreshLock(held.payload, ref, 'mine')).toBe(true)
    expect(held.update).toHaveBeenCalledWith({
      collection: LOCKS_SLUG,
      where: {
        and: [
          { entityType: { equals: 'collection' } },
          { collectionSlug: { equals: 'events' } },
          { docId: { equals: 'e1' } },
          { token: { equals: 'mine' } },
        ],
      },
      data: { token: 'mine' },
      depth: 0,
    })

    const lost = fakePayload({ creates: [], updated: [] })
    expect(await refreshLock(lost.payload, ref, 'mine')).toBe(false)
  })

  it('releases only a lock that carries the token', async () => {
    const { payload, remove } = fakePayload({ creates: [] })

    await releaseLock(payload, ref, 'mine')

    expect(remove).toHaveBeenCalledWith({
      collection: LOCKS_SLUG,
      where: {
        and: [
          { entityType: { equals: 'collection' } },
          { collectionSlug: { equals: 'events' } },
          { docId: { equals: 'e1' } },
          { token: { equals: 'mine' } },
        ],
      },
    })
  })

  it('counts a lock as live within the busy window only', () => {
    expect(isLiveLock(lockAged(BUSY_WINDOW_MS - 1) as { updatedAt: string })).toBe(true)
    expect(isLiveLock(lockAged(BUSY_WINDOW_MS + 1) as { updatedAt: string })).toBe(false)
  })
})
