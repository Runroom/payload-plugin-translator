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
// The conditional delete and the refresh go through the adapter (`payload.db`), never
// through Payload's `delete` and `update` operations, which are not provided.
const fakePayload = ({
  creates,
  finds = [],
  refreshed = null,
}: {
  creates: boolean[]
  finds?: Record<string, unknown>[][]
  refreshed?: Record<string, unknown> | null
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
  const remove = vi.fn().mockResolvedValue(undefined)
  const update = vi.fn().mockResolvedValue(refreshed)
  return {
    payload: {
      create,
      find,
      db: { deleteMany: remove, updateOne: update },
    } as unknown as Payload,
    create,
    remove,
    update,
  }
}

const whereHeld = (token: string): { and: Record<string, unknown>[] } => ({
  and: [
    { entityType: { equals: 'collection' } },
    { collectionSlug: { equals: 'events' } },
    { docId: { equals: 'e1' } },
    { token: { equals: token } },
  ],
})

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

  it('deletes an expired lock in one adapter statement, by token and only if still expired', async () => {
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
          ...whereHeld('other').and,
          { updatedAt: { less_than: expect.any(String) } },
        ],
      },
    })
    // A heartbeat that lands before the statement moves `updatedAt` past the cutoff, so
    // the delete matches nothing: the age filter is part of the statement itself.
    const [{ where }] = remove.mock.calls[0] as [{ where: { and: unknown[] } }]
    const cutoff = Date.parse(
      (where.and[4] as { updatedAt: { less_than: string } }).updatedAt.less_than,
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
  it('refreshes with one atomic adapter update by token, stamping updatedAt, and reports a lost one', async () => {
    const held = fakePayload({ creates: [], refreshed: lockAged(0, 'mine') })
    const before = Date.now()

    expect(await refreshLock(held.payload, ref, 'mine')).toBe(true)

    expect(held.update).toHaveBeenCalledWith({
      collection: LOCKS_SLUG,
      where: whereHeld('mine'),
      data: { updatedAt: expect.any(String) },
      options: { atomic: true },
    })
    const [{ data }] = held.update.mock.calls[0] as [{ data: { updatedAt: string } }]
    expect(Date.parse(data.updatedAt)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(data.updatedAt)).toBeLessThanOrEqual(Date.now())

    // The adapter answers `null` when no row carries the token.
    const lost = fakePayload({ creates: [], refreshed: null })
    expect(await refreshLock(lost.payload, ref, 'mine')).toBe(false)
  })

  it('releases only a lock that carries the token, through the adapter', async () => {
    const { payload, remove } = fakePayload({ creates: [] })

    await releaseLock(payload, ref, 'mine')

    expect(remove).toHaveBeenCalledWith({
      collection: LOCKS_SLUG,
      where: whereHeld('mine'),
    })
  })

  it('counts a lock as live within the busy window only', () => {
    expect(isLiveLock(lockAged(BUSY_WINDOW_MS - 1) as { updatedAt: string })).toBe(true)
    expect(isLiveLock(lockAged(BUSY_WINDOW_MS + 1) as { updatedAt: string })).toBe(false)
  })
})
