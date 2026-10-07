import { describe, expect, it, vi } from 'vitest'

import { BUSY_WINDOW_MS } from '../../../src/server/limits.js'
import { settings, endpoint, request, recent, requester, lockedSince } from './helpers.js'

// Payload resolves per-document permissions by reading the database; here each test sets
// them.
vi.mock('payload', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  docAccessOperation: vi.fn(async () => ({ fields: true, read: true, update: true })),
  docAccessOperationGlobal: vi.fn(async () => ({
    fields: true,
    read: true,
    update: true,
  })),
}))

describe('POST /translator/translate', () => {
  it('rejects users the access function denies', async () => {
    const { req, queue } = request({
      body: { collection: 'events', id: 'e1', sourceLocale: 'es', targetLocales: ['ca'] },
    })

    const response = await endpoint(
      settings({ access: () => false }),
      '/translator/translate',
    )(req)

    expect(response.status).toBe(403)
    expect(queue).not.toHaveBeenCalled()
  })

  it('answers 503 when no provider is configured', async () => {
    const { req } = request({
      body: { collection: 'events', id: 'e1', sourceLocale: 'es', targetLocales: ['ca'] },
    })

    const response = await endpoint(
      settings({ provider: null }),
      '/translator/translate',
    )(req)

    expect(response.status).toBe(503)
  })

  it('queues a single job with every requested locale and starts only that job', async () => {
    const { req, queue, run, create } = request({
      body: {
        collection: 'events',
        id: 'e1',
        sourceLocale: 'es',
        targetLocales: ['ca', 'en'],
        overwriteEdited: false,
      },
    })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(202)
    expect(queue).toHaveBeenCalledTimes(1)
    expect(queue).toHaveBeenCalledWith({
      task: 'translateDocument',
      queue: 'translations',
      input: {
        entityType: 'collection',
        collectionSlug: 'events',
        docId: 'e1',
        sourceLocale: 'es',
        targetLocales: ['ca', 'en'],
        overwriteEdited: false,
        requester,
        lockToken: expect.any(String),
      },
    })
    expect(run).toHaveBeenCalledWith({
      queue: 'translations',
      limit: 1,
      where: { id: { in: ['job-1'] } },
    })
    expect(create.mock.calls.map(([args]) => args.data)).toEqual([
      expect.objectContaining({ targetLocale: 'ca', status: 'queued' }),
      expect.objectContaining({ targetLocale: 'en', status: 'queued' }),
    ])
  })

  it('queues the requester’s identity, not their permissions, for the job', async () => {
    const { req, queue } = request({
      body: { collection: 'events', id: 'e1', sourceLocale: 'es', targetLocales: ['ca'] },
      user: { id: 'u7', collection: 'editors' },
    })

    await endpoint(settings(), '/translator/translate')(req)

    const { input } = queue.mock.calls[0]![0]
    expect(input.requester).toEqual({ id: 'u7', collection: 'editors' })
    expect(input).not.toHaveProperty('fieldPermissions')
  })

  it('refuses a request without a user even when the access function allows it', async () => {
    const { req, queue } = request({
      body: { collection: 'events', id: 'e1', sourceLocale: 'es', targetLocales: ['ca'] },
      user: null,
    })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(403)
    expect(queue).not.toHaveBeenCalled()
  })

  it('answers 409 when another locale of the same document is busy', async () => {
    const { req, queue } = request({
      body: { collection: 'events', id: 'e1', sourceLocale: 'es', targetLocales: ['ca'] },
      lock: lockedSince(0),
      records: [recent('en', 'running')],
    })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'busy', busy: ['en'] })
    expect(queue).not.toHaveBeenCalled()
  })

  it('logs a failed queue run instead of failing the request', async () => {
    const error = new Error('boom')
    const { req, logError } = request({
      body: { collection: 'events', id: 'e1', sourceLocale: 'es', targetLocales: ['ca'] },
      runError: error,
    })

    const response = await endpoint(settings(), '/translator/translate')(req)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(response.status).toBe(202)
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ err: error }))
  })

  it('marks the records failed, releases the lock and answers 500 when queueing the job fails', async () => {
    const { req, create, run, locks, logError } = request({
      body: { collection: 'events', id: 'e1', sourceLocale: 'es', targetLocales: ['ca'] },
      queueError: new Error('db down'),
    })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'failed' })
    expect(create.mock.calls.map(([args]) => args.data.status)).toEqual([
      'queued',
      'failed',
    ])
    expect(locks.delete).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'translation-locks' }),
    )
    expect(run).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ message: 'db down' }) }),
    )
  })

  it('saves the queued records before queueing the job', async () => {
    const order: string[] = []
    const { req, create, queue } = request({
      body: { collection: 'events', id: 'e1', sourceLocale: 'es', targetLocales: ['ca'] },
    })
    create.mockImplementation(() => {
      order.push('record')
    })
    queue.mockImplementation(() => {
      order.push('job')
      return { id: 'job-1' }
    })

    await endpoint(settings(), '/translator/translate')(req)

    expect(order).toEqual(['record', 'job'])
  })

  it('answers 400 to a body that is not valid JSON', async () => {
    const { req, queue } = request({ invalidJson: true })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(400)
    expect(queue).not.toHaveBeenCalled()
  })

  it('answers 404 for a document that does not exist, without records or jobs', async () => {
    const { req, queue, create, findByID } = request({
      body: {
        collection: 'events',
        id: 'missing',
        sourceLocale: 'es',
        targetLocales: ['ca'],
      },
      doc: null,
    })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not-found' })
    expect(findByID).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'missing', depth: 0, disableErrors: true }),
    )
    expect(queue).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('queues nothing when only one of the requested locales is busy', async () => {
    const { req, queue } = request({
      body: {
        collection: 'events',
        id: 'e1',
        sourceLocale: 'es',
        targetLocales: ['ca', 'en'],
      },
      lock: lockedSince(0),
      records: [recent('ca', 'running')],
    })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'busy', busy: ['ca'] })
    expect(queue).not.toHaveBeenCalled()
  })

  it('treats a recent queued record as busy', async () => {
    const { req, queue } = request({
      body: { collection: 'events', id: 'e1', sourceLocale: 'es', targetLocales: ['ca'] },
      lock: lockedSince(0),
      records: [recent('ca', 'queued')],
    })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(409)
    expect(queue).not.toHaveBeenCalled()
  })

  it('reports a pending record busy while the lock is held, however old its heartbeat', async () => {
    const { req, queue } = request({
      body: { collection: 'events', id: 'e1', sourceLocale: 'es', targetLocales: ['ca'] },
      lock: lockedSince(0),
      records: [
        {
          ...recent('en', 'queued'),
          updatedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        },
      ],
    })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'busy', busy: ['en'] })
    expect(queue).not.toHaveBeenCalled()
  })

  it('reports the requested locales busy when the lock is held but no record is pending yet', async () => {
    const { req, queue } = request({
      body: {
        collection: 'events',
        id: 'e1',
        sourceLocale: 'es',
        targetLocales: ['ca', 'en'],
      },
      lock: lockedSince(0),
    })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'busy', busy: ['ca', 'en'] })
    expect(queue).not.toHaveBeenCalled()
  })

  it('lets a finished translation be run again', async () => {
    const { req, queue } = request({
      body: { collection: 'events', id: 'e1', sourceLocale: 'es', targetLocales: ['ca'] },
      records: [recent('ca', 'done')],
    })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(202)
    expect(queue).toHaveBeenCalledTimes(1)
  })

  it('answers 400 without a source locale', async () => {
    const { req, queue } = request({
      body: { collection: 'events', id: 'e1', targetLocales: ['ca'] },
    })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(400)
    expect(queue).not.toHaveBeenCalled()
  })

  it('answers 400 to a source locale the entity does not translate between', async () => {
    const { req, queue } = request({
      body: { collection: 'events', id: 'e1', sourceLocale: 'fr', targetLocales: ['ca'] },
    })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(400)
    expect(queue).not.toHaveBeenCalled()
  })

  it('translates from the open locale towards the others, checking the document there', async () => {
    const { req, queue, findByID } = request({
      body: {
        collection: 'events',
        id: 'e1',
        sourceLocale: 'ca',
        targetLocales: ['es', 'en', 'ca'],
      },
    })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ queued: ['es', 'en'] })
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          sourceLocale: 'ca',
          targetLocales: ['es', 'en'],
        }),
      }),
    )
    expect(findByID).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'ca', disableErrors: true }),
    )
  })

  it('ignores the source and unknown locales among the targets and rejects an empty selection', async () => {
    const { req, queue } = request({
      body: {
        collection: 'events',
        id: 'e1',
        sourceLocale: 'es',
        targetLocales: ['es', 'fr'],
      },
    })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(400)
    expect(queue).not.toHaveBeenCalled()
  })

  it('answers 409 when a translation for that locale is already in progress', async () => {
    const { req, queue } = request({
      body: { collection: 'events', id: 'e1', sourceLocale: 'es', targetLocales: ['ca'] },
      lock: lockedSince(0),
      records: [
        {
          id: 'r1',
          targetLocale: 'ca',
          status: 'running',
          updatedAt: new Date().toISOString(),
        },
      ],
    })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(409)
    expect(queue).not.toHaveBeenCalled()
  })

  it('takes over a lock abandoned long ago instead of treating it as in progress', async () => {
    const { req, queue, locks } = request({
      body: { collection: 'events', id: 'e1', sourceLocale: 'es', targetLocales: ['ca'] },
      lock: lockedSince(BUSY_WINDOW_MS + 1),
      records: [
        {
          id: 'r1',
          targetLocale: 'ca',
          status: 'running',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
      ],
    })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(202)
    expect(locks.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          and: [
            { id: { equals: 'l-other' } },
            { token: { equals: 'other-token' } },
            { updatedAt: { less_than: expect.any(String) } },
          ],
        },
      }),
    )
    expect(queue).toHaveBeenCalledTimes(1)
  })
})

describe('POST /translator/translate when the records cannot be saved', () => {
  it('queues nothing, releases the lock and answers a plain 500', async () => {
    const { req, run, queue, locks, logError } = request({
      body: { collection: 'events', id: 'e1', sourceLocale: 'es', targetLocales: ['ca'] },
      createError: new Error('db down'),
    })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'failed' })
    expect(queue).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(locks.delete).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
    )
  })
})
