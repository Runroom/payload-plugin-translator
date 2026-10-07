import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { isTranslatorWrite, RECORDS_SLUG } from '../../src/index.js'
import type { Harness } from './helpers.js'

// SQLite transactions are off unless the adapter gets `transactionOptions`; the dev config
// turns them on for this flag. It must be set before the config module is imported, hence
// the dynamic imports (this file runs in its own worker, so nothing else sees the flag).
process.env.PAYLOAD_SQLITE_TRANSACTIONS = '1'
const { provider } = await import('../../dev/payload.config.js')
const { boot, drainQueue, findLock, findRecord, listJobs, queueOnly, runJob, shutdown } =
  await import('./helpers.js')

type Update = Harness['payload']['update']

describe('the document write and its record inside one transaction', () => {
  let harness: Harness
  const sent = vi.spyOn(provider, 'translate')

  beforeAll(async () => {
    harness = await boot()
  })

  afterAll(async () => {
    sent.mockRestore()
    await shutdown(harness)
  })

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

  it('rolls the write back when the record cannot be saved, and the retry translates again', async () => {
    const { payload } = harness
    const id = String(
      (
        await payload.create({
          collection: 'posts' as never,
          locale: 'en',
          data: { title: 'Atomic', _status: 'published' } as never,
        })
      ).id,
    )
    const ref = { entityType: 'collection' as const, collectionSlug: 'posts', docId: id }
    const original = payload.update.bind(payload) as Update
    let failed = false
    // The `done` record save fails once, after the document was written in the same
    // transaction.
    const update = vi.spyOn(payload, 'update').mockImplementation(((args: {
      collection: string
      data?: { status?: string }
    }) => {
      if (args.collection === RECORDS_SLUG && args.data?.status === 'done' && !failed) {
        failed = true
        return Promise.reject(new Error('record save failed'))
      }
      return original(args as never)
    }) as never)

    try {
      const reply = await queueOnly(harness, {
        collection: 'posts',
        id,
        sourceLocale: 'en',
        targetLocales: ['es'],
      })
      expect(reply.status).toBe(202)
      const [job] = await listJobs(harness)
      await runJob(harness, job!.id)

      expect(failed).toBe(true)
      expect(await readDraftTitle(id, 'es')).toBeFalsy()
      expect(await findRecord(harness, { docId: id, targetLocale: 'es' })).toMatchObject({
        status: 'queued',
        error: 'record save failed',
      })
      // The job will be retried, so the document stays locked meanwhile.
      expect(await findLock(harness, ref)).toBeDefined()

      // Payload schedules the retry after its backoff; the test does not wait for it.
      await payload.update({
        collection: 'payload-jobs' as never,
        id: job!.id,
        data: { waitUntil: null } as never,
      })
      await drainQueue(harness)
    } finally {
      update.mockRestore()
    }

    expect(await readDraftTitle(id, 'es')).toBe('[es] Atomic')
    const record = await findRecord(harness, { docId: id, targetLocale: 'es' })
    expect(record).toMatchObject({ status: 'done', error: null, kept: [] })
    expect(record?.fields?.title).toEqual({
      source: expect.any(String),
      output: expect.any(String),
    })
    // Nothing of the rolled-back attempt survived, so the retry translated the text again
    // instead of keeping it as a hand edit.
    expect(sent).toHaveBeenCalledTimes(2)
    expect(await findLock(harness, ref)).toBeUndefined()
  })

  it('verifies the write after the commit, so a save that lands right after it is noticed', async () => {
    const { payload } = harness
    sent.mockClear()
    const id = String(
      (
        await payload.create({
          collection: 'posts' as never,
          locale: 'en',
          data: { title: 'Verified', _status: 'published' } as never,
        })
      ).id,
    )
    const ref = { entityType: 'collection' as const, collectionSlug: 'posts', docId: id }
    const originalUpdate = payload.update.bind(payload) as Update
    let translatorTransaction: unknown = null
    const update = vi.spyOn(payload, 'update').mockImplementation(((args: {
      collection: string
      context?: unknown
      req?: { transactionID?: unknown }
    }) => {
      if (args.collection === 'posts' && isTranslatorWrite(args.context)) {
        translatorTransaction = args.req?.transactionID
      }
      return originalUpdate(args as never)
    }) as never)
    const originalCommit = payload.db.commitTransaction.bind(payload.db)
    let landed = false
    // A save of the same document that waited on the row locks lands right after the
    // translator's transaction commits, before anything else runs.
    const commit = vi
      .spyOn(payload.db, 'commitTransaction')
      .mockImplementation(async transactionID => {
        await originalCommit(transactionID)
        if (landed || transactionID !== translatorTransaction) return
        landed = true
        await originalUpdate({
          collection: 'posts' as never,
          id,
          locale: 'es' as never,
          draft: true,
          data: { title: 'Edited meanwhile' } as never,
        })
      })

    try {
      expect(
        (
          await queueOnly(harness, {
            collection: 'posts',
            id,
            sourceLocale: 'en',
            targetLocales: ['es'],
          })
        ).status,
      ).toBe(202)
      const [job] = await listJobs(harness)
      await runJob(harness, job!.id)

      expect(landed).toBe(true)
      // The committed `done` record was corrected: the title no longer counts as ours.
      const record = await findRecord(harness, { docId: id, targetLocale: 'es' })
      expect(record).toMatchObject({
        status: 'queued',
        error: expect.stringContaining('concurrent edit'),
      })
      expect(record?.fields).toEqual({})
      expect(await findLock(harness, ref)).toBeDefined()

      await payload.update({
        collection: 'payload-jobs' as never,
        id: job!.id,
        data: { waitUntil: null } as never,
      })
      await drainQueue(harness)
    } finally {
      commit.mockRestore()
      update.mockRestore()
    }

    // The retry keeps the text that landed as a hand edit instead of overwriting it.
    expect(await readDraftTitle(id, 'es')).toBe('Edited meanwhile')
    expect(await findRecord(harness, { docId: id, targetLocale: 'es' })).toMatchObject({
      status: 'done',
      error: null,
      kept: ['title'],
    })
    expect(sent).toHaveBeenCalledTimes(1)
    expect(await findLock(harness, ref)).toBeUndefined()
  })
})
