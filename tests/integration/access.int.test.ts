import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { RECORDS_SLUG } from '../../src/index.js'
import type { Harness } from './helpers.js'
import { boot, drainQueue, QUEUE, shutdown, status, translate } from './helpers.js'

describe('who may translate and when', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await boot()
  })

  afterAll(async () => {
    await shutdown(harness)
  })

  const createPost = async (title: string): Promise<string> =>
    String(
      (
        await harness.payload.create({
          collection: 'posts',
          locale: 'en',
          data: { title } as never,
        })
      ).id,
    )

  it('denies a request without a user', async () => {
    const id = await createPost('Anonymous')
    const body = { collection: 'posts', id, sourceLocale: 'en', targetLocales: ['es'] }
    const runsBefore = harness.runs.mock.calls.length

    const reply = await translate(harness, body, null)

    expect(reply).toEqual({ status: 403, body: { error: 'forbidden' } })
    expect(harness.runs.mock.calls.length).toBe(runsBefore)
    expect(await harness.payload.count({ collection: 'payload-jobs' as never })).toEqual({
      totalDocs: 0,
    })
  })

  it('answers 409 while a translation of the document is still queued', async () => {
    const id = await createPost('Busy')
    const body = { collection: 'posts', id, sourceLocale: 'en', targetLocales: ['es'] }
    // Swallow the run `POST /translate` starts on its own, so the job stays queued until
    // the test runs the queue.
    harness.runs.mockResolvedValueOnce({ noJobsRemaining: false } as never)

    expect(await translate(harness, body)).toEqual({
      status: 202,
      body: { queued: ['es'] },
    })
    expect(await translate(harness, { ...body, targetLocales: ['fr'] })).toEqual({
      status: 409,
      body: { error: 'busy', busy: ['es'] },
    })
    const queued = await status(harness, { collection: 'posts', id })
    expect(queued.body.locales.find(item => item.locale === 'es')?.state).toBe('queued')

    await harness.payload.jobs.run({ queue: QUEUE })
    await drainQueue(harness)

    expect(await translate(harness, { ...body, targetLocales: ['fr'] })).toMatchObject({
      status: 202,
    })
    await drainQueue(harness)
  })

  it('closes the records collection to everyone outside the plugin', async () => {
    const options = {
      collection: RECORDS_SLUG as never,
      overrideAccess: false,
      user: harness.user,
    }

    await expect(harness.payload.find(options)).rejects.toMatchObject({ status: 403 })
    await expect(
      harness.payload.create({
        ...options,
        data: {
          collectionSlug: 'posts',
          docId: 'forged',
          targetLocale: 'es',
          status: 'done',
        } as never,
      }),
    ).rejects.toMatchObject({ status: 403 })
  })

  // `saveRecord` relies on this index to settle two jobs creating the same record.
  it('keeps one record per document and target locale', async () => {
    const record = {
      entityType: 'collection',
      collectionSlug: 'posts',
      docId: 'unique-check',
      targetLocale: 'es',
    }
    await harness.payload.create({ collection: RECORDS_SLUG as never, data: record })

    await expect(
      harness.payload.create({ collection: RECORDS_SLUG as never, data: record }),
    ).rejects.toThrow()
  })
})
