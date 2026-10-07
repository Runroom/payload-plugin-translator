import { docAccessOperation, docAccessOperationGlobal } from 'payload'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { settings, endpoint, request, recent } from './helpers.js'

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

describe('authorisation per document', () => {
  const body = {
    collection: 'events',
    id: 'e1',
    sourceLocale: 'es',
    targetLocales: ['ca'],
  }
  const permissions = (read: boolean, update: boolean): void => {
    vi.mocked(docAccessOperation).mockResolvedValueOnce({
      fields: {},
      read,
      update,
    } as never)
  }

  beforeEach(() => {
    vi.mocked(docAccessOperation).mockClear()
    vi.mocked(docAccessOperationGlobal).mockClear()
  })

  it('hands the plugin access function the document and the operation', async () => {
    const access = vi.fn().mockResolvedValue(true)
    const translate = request({ body })
    const status = request({ query: 'global=footer' })

    await endpoint(settings({ access }), '/translator/translate')(translate.req)
    await endpoint(settings({ access }), '/translator/status')(status.req)

    expect(access).toHaveBeenNthCalledWith(1, {
      req: translate.req,
      ref: { entityType: 'collection', collectionSlug: 'events', docId: 'e1' },
      operation: 'translate',
    })
    expect(access).toHaveBeenNthCalledWith(2, {
      req: status.req,
      ref: { entityType: 'global', collectionSlug: 'footer', docId: 'global' },
      operation: 'status',
    })
  })

  it('asks Payload whether the request user may read and update that very document', async () => {
    const { req } = request({ body })

    await endpoint(settings(), '/translator/translate')(req)

    expect(docAccessOperation).toHaveBeenCalledWith({
      req,
      collection: req.payload.collections.events,
      id: 'e1',
    })
  })

  it('answers 404 to a translate the user may not read, without queueing', async () => {
    permissions(false, true)
    const { req, queue, create } = request({ body })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not-found' })
    expect(queue).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('answers 403 to a translate the user may read but not update', async () => {
    permissions(true, false)
    const { req, queue } = request({ body })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'forbidden' })
    expect(queue).not.toHaveBeenCalled()
  })

  it('answers 404 to the status of a document the user may not read', async () => {
    permissions(false, false)
    const { req } = request({ query: 'collection=events&id=e1' })

    const response = await endpoint(settings(), '/translator/status')(req)

    expect(response.status).toBe(404)
  })

  it('checks a global through its own access operation', async () => {
    vi.mocked(docAccessOperationGlobal).mockResolvedValueOnce({
      fields: {},
      read: true,
      update: false,
    } as never)
    const { req, queue } = request({
      body: { global: 'footer', sourceLocale: 'es', targetLocales: ['ca'] },
    })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(403)
    expect(docAccessOperationGlobal).toHaveBeenCalledWith({
      req,
      globalConfig: expect.objectContaining({ slug: 'footer' }),
    })
    expect(queue).not.toHaveBeenCalled()
  })
})

describe('ids the database adapter cannot parse', () => {
  const invalidUuid = Object.assign(new Error('invalid input syntax for type uuid'), {
    code: '22P02',
  })

  it('answers 404 to a translate for an id that is not a valid id', async () => {
    const { req, queue } = request({
      body: {
        collection: 'events',
        id: 'not-a-uuid',
        sourceLocale: 'es',
        targetLocales: ['ca'],
      },
      findError: invalidUuid,
    })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(404)
    expect(queue).not.toHaveBeenCalled()
  })

  it('answers 404 to the status of an id that is not a valid id', async () => {
    const { req } = request({
      query: 'collection=events&id=not-a-uuid',
      findError: invalidUuid,
    })

    const response = await endpoint(settings(), '/translator/status')(req)

    expect(response.status).toBe(404)
  })

  it('still surfaces other database errors', async () => {
    const { req } = request({
      query: 'collection=events&id=e1',
      findError: new Error('connection refused'),
    })

    await expect(endpoint(settings(), '/translator/status')(req)).rejects.toThrow(
      'connection refused',
    )
  })
})

describe('translator endpoints for a global', () => {
  it('queues a job keyed on the global and its records', async () => {
    const { req, queue, create } = request({
      body: { global: 'footer', sourceLocale: 'es', targetLocales: ['ca'] },
    })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(202)
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          entityType: 'global',
          collectionSlug: 'footer',
          docId: 'global',
          sourceLocale: 'es',
          targetLocales: ['ca'],
          overwriteEdited: false,
          fieldPermissions: true,
        },
      }),
    )
    expect(create.mock.calls.map(([args]) => args.data)).toEqual([
      expect.objectContaining({
        entityType: 'global',
        collectionSlug: 'footer',
        docId: 'global',
        targetLocale: 'ca',
        status: 'queued',
      }),
    ])
  })

  it('answers 404 to a global the translator is not configured for', async () => {
    const { req, queue } = request({
      body: { global: 'menu', sourceLocale: 'es', targetLocales: ['ca'] },
    })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(404)
    expect(queue).not.toHaveBeenCalled()
  })

  it('answers 409 while the global is being translated', async () => {
    const { req, queue } = request({
      body: { global: 'footer', sourceLocale: 'es', targetLocales: ['ca'] },
      records: [recent('ca', 'running')],
    })

    const response = await endpoint(settings(), '/translator/translate')(req)

    expect(response.status).toBe(409)
    expect(queue).not.toHaveBeenCalled()
  })

  it('reports the status of a global without drafts as written live', async () => {
    const { req, findGlobal, find } = request({ query: 'global=footer' })

    const response = await endpoint(settings(), '/translator/status')(req)
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ enabled: true, writesLive: true })
    expect(findGlobal).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'footer', locale: 'es', depth: 0 }),
    )
    expect(findGlobal.mock.calls[0]![0]).not.toHaveProperty('draft')
    expect(find.mock.calls[0]![0].where.and).toContainEqual({
      entityType: { equals: 'global' },
    })
  })

  it('answers 404 to the status of a global the translator is not configured for', async () => {
    const { req } = request({ query: 'global=menu' })

    const response = await endpoint(settings(), '/translator/status')(req)

    expect(response.status).toBe(404)
  })

  it('answers 404 when the configured global is not registered in Payload', async () => {
    const { req } = request({ query: 'global=footer', globals: [] })

    const response = await endpoint(settings(), '/translator/status')(req)

    expect(response.status).toBe(404)
  })
})
