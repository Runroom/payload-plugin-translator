import { describe, expect, it, vi } from 'vitest'

import { settings, endpoint, request, recent, requester } from './helpers.js'

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

  it('does not leave a queued record behind when queueing the job fails', async () => {
    const { req, create } = request({
      body: { collection: 'events', id: 'e1', sourceLocale: 'es', targetLocales: ['ca'] },
      queueError: new Error('db down'),
    })

    await expect(endpoint(settings(), '/translator/translate')(req)).rejects.toThrow(
      'db down',
    )
    expect(create).not.toHaveBeenCalled()
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
      records: [recent('ca', 'queued')],
    })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(409)
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

  it('does not treat a run abandoned long ago as in progress', async () => {
    const { req, queue } = request({
      body: { collection: 'events', id: 'e1', sourceLocale: 'es', targetLocales: ['ca'] },
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
    expect(queue).toHaveBeenCalledTimes(1)
  })
})

describe('POST /translator/translate when the records cannot be saved', () => {
  it('still runs the queued job and answers 500 so the client knows the lock is uncertain', async () => {
    const { req, run, logError } = request({
      body: { collection: 'events', id: 'e1', sourceLocale: 'es', targetLocales: ['ca'] },
      createError: new Error('db down'),
    })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'records-failed', queued: ['ca'] })
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['job-1'] } } }),
    )
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
    )
  })
})
