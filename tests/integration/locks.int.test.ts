import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { provider } from '../../dev/payload.config.js'
import { ProviderError } from '../../src/index.js'
import { BUSY_WINDOW_MS } from '../../src/server/limits.js'
import { LOCK_LOST } from '../../src/server/localeRun.js'
import { LOCKS_SLUG } from '../../src/server/lock.js'
import type { Harness } from './helpers.js'
import {
  ageLock,
  boot,
  clearFailedJobs,
  drainQueue,
  findLock,
  findRecord,
  listJobs,
  queueOnly,
  runJob,
  shutdown,
  translate,
  translateAndWait,
} from './helpers.js'

// The document lock is a row in `translation-locks` with a unique index per entity, so
// taking it is atomic in the database and does not depend on Payload's job runner.
describe('the per-document lock', () => {
  let harness: Harness
  const sent = vi.spyOn(provider, 'translate')

  beforeAll(async () => {
    harness = await boot()
  })

  afterEach(() => {
    sent.mockClear()
  })

  afterAll(async () => {
    sent.mockRestore()
    await shutdown(harness)
  })

  const createPost = async (title: string): Promise<string> =>
    String(
      (
        await harness.payload.create({
          collection: 'posts' as never,
          locale: 'en',
          data: { title, _status: 'published' } as never,
        })
      ).id,
    )

  const readDraftTitle = async (id: string, locale: string): Promise<unknown> =>
    (
      (await harness.payload.findByID({
        collection: 'posts' as never,
        id,
        locale: locale as never,
        draft: true,
        fallbackLocale: false as never,
        depth: 0,
      })) as unknown as { title?: unknown }
    ).title

  const refOf = (id: string): Parameters<typeof findLock>[1] => ({
    entityType: 'collection',
    collectionSlug: 'posts',
    docId: id,
  })

  const bodyOf = (id: string): Parameters<typeof translate>[1] => ({
    collection: 'posts',
    id,
    sourceLocale: 'en',
    targetLocales: ['es'],
  })

  it('lets exactly one of two simultaneous requests through and queues one job', async () => {
    const id = await createPost('Raced')
    const queue = vi.spyOn(harness.payload.jobs, 'queue')
    // Only the winner starts its job; the mock keeps it from running until the queue is drained.
    harness.runs.mockResolvedValueOnce({ noJobsRemaining: false } as never)

    const replies = await Promise.all([
      translate(harness, bodyOf(id)),
      translate(harness, bodyOf(id)),
    ])

    expect(replies.map(reply => reply.status).sort()).toEqual([202, 409])
    expect(replies.find(reply => reply.status === 409)?.body).toEqual({
      error: 'busy',
      busy: ['es'],
    })
    expect(queue).toHaveBeenCalledTimes(1)
    expect(await listJobs(harness)).toHaveLength(1)
    queue.mockRestore()

    await drainQueue(harness)

    expect(await readDraftTitle(id, 'es')).toBe('[es] Raced')
    expect(await findRecord(harness, { docId: id, targetLocale: 'es' })).toMatchObject({
      status: 'done',
    })
    // Released once the job is done, so the document can be translated again.
    expect(await findLock(harness, refOf(id))).toBeUndefined()
  })

  it('saves the queued records before the job exists', async () => {
    const id = await createPost('Ordered')
    const original = harness.payload.jobs.queue.bind(harness.payload.jobs)
    let recordAtQueue: unknown = 'not read'
    const queue = vi
      .spyOn(harness.payload.jobs, 'queue')
      .mockImplementation(async args => {
        recordAtQueue = await findRecord(harness, { docId: id, targetLocale: 'es' })
        return original(args)
      })

    try {
      await translateAndWait(harness, bodyOf(id))
    } finally {
      queue.mockRestore()
    }

    expect(recordAtQueue).toMatchObject({ status: 'queued' })
  })

  it('lets a new request take over an expired lock and cancels the old job as superseded', async () => {
    const id = await createPost('Taken over')
    expect((await queueOnly(harness, bodyOf(id))).status).toBe(202)
    const [oldJob] = await listJobs(harness)
    const oldLock = (await findLock(harness, refOf(id)))!
    await ageLock(harness, oldLock, BUSY_WINDOW_MS + 1)

    expect((await queueOnly(harness, bodyOf(id))).status).toBe(202)

    const newLock = (await findLock(harness, refOf(id)))!
    expect(newLock.token).not.toBe(oldLock.token)
    const jobs = await listJobs(harness)
    expect(jobs).toHaveLength(2)
    expect(jobs[1]!.input.lockToken).toBe(newLock.token)

    await runJob(harness, oldJob!.id)

    const cancelled = (await listJobs(harness)).find(job => job.id === oldJob!.id)
    expect(cancelled?.error).toMatchObject({ cancelled: true, message: LOCK_LOST })
    expect(sent).not.toHaveBeenCalled()
    expect(await readDraftTitle(id, 'es')).toBeFalsy()
    // The records still describe the new request, which the old job must not touch.
    expect(await findRecord(harness, { docId: id, targetLocale: 'es' })).toMatchObject({
      status: 'queued',
      error: null,
    })
    expect((await findLock(harness, refOf(id)))?.token).toBe(newLock.token)

    await clearFailedJobs(harness)
    await drainQueue(harness)

    expect(await readDraftTitle(id, 'es')).toBe('[es] Taken over')
    expect(await findLock(harness, refOf(id))).toBeUndefined()
  })

  it('does not take over a lock its holder refreshed between the lookup and the delete', async () => {
    const id = await createPost('Refreshed')
    expect((await queueOnly(harness, bodyOf(id))).status).toBe(202)
    const lock = (await findLock(harness, refOf(id)))!
    await ageLock(harness, lock, BUSY_WINDOW_MS + 1)
    const originalDelete = harness.payload.delete.bind(harness.payload)
    // The holder's heartbeat lands after the taker read the expired lock and before it
    // deletes it: the delete must not match any more.
    const remove = vi.spyOn(harness.payload, 'delete').mockImplementation((async (args: {
      collection: string
    }) => {
      if (args.collection === LOCKS_SLUG) await ageLock(harness, lock, 0)
      return originalDelete(args as never)
    }) as never)

    try {
      expect((await translate(harness, bodyOf(id))).status).toBe(409)
    } finally {
      remove.mockRestore()
    }

    expect((await findLock(harness, refOf(id)))?.token).toBe(lock.token)
    expect(await listJobs(harness)).toHaveLength(1)

    await drainQueue(harness)

    expect(await readDraftTitle(id, 'es')).toBe('[es] Refreshed')
    expect(await findLock(harness, refOf(id))).toBeUndefined()
  })

  it('releases the lock after a job that failed for good', async () => {
    const id = await createPost('Refused')
    sent.mockRejectedValueOnce(new ProviderError('refused', false))
    expect((await queueOnly(harness, bodyOf(id))).status).toBe(202)
    const [job] = await listJobs(harness)

    await runJob(harness, job!.id)

    expect(await findRecord(harness, { docId: id, targetLocale: 'es' })).toMatchObject({
      status: 'failed',
      error: 'refused',
    })
    expect(await findLock(harness, refOf(id))).toBeUndefined()
    await clearFailedJobs(harness)

    await translateAndWait(harness, bodyOf(id))

    expect(await readDraftTitle(id, 'es')).toBe('[es] Refused')
  })

  it('does not stay blocked by a job whose process died while it was running', async () => {
    const id = await createPost('Crashed')
    expect((await queueOnly(harness, bodyOf(id))).status).toBe(202)
    const [dangling] = await listJobs(harness)
    // A dead process leaves the job `processing` and the lock without a heartbeat.
    await harness.payload.update({
      collection: 'payload-jobs' as never,
      id: dangling!.id,
      data: { processing: true } as never,
    })
    await ageLock(harness, (await findLock(harness, refOf(id)))!, BUSY_WINDOW_MS + 1)

    expect((await queueOnly(harness, bodyOf(id))).status).toBe(202)
    const [, fresh] = await listJobs(harness)
    await runJob(harness, fresh!.id)

    expect(await readDraftTitle(id, 'es')).toBe('[es] Crashed')
    expect(await findRecord(harness, { docId: id, targetLocale: 'es' })).toMatchObject({
      status: 'done',
    })
    expect(await findLock(harness, refOf(id))).toBeUndefined()
    await harness.payload.delete({
      collection: 'payload-jobs' as never,
      id: dangling!.id,
    })
  })
})
