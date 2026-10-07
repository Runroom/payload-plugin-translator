import type { PayloadRequest } from 'payload'
import { docAccessOperation, docAccessOperationGlobal } from 'payload'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fingerprintOf } from '../src/core/fingerprint.js'
import { fakeProvider } from '../src/exports/testing.js'
import { translatorEndpoints } from '../src/server/endpoints.js'
import type { TranslatorSettings } from '../src/server/settings.js'

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

const settings = (overrides: Partial<TranslatorSettings> = {}): TranslatorSettings => ({
  collections: { events: { locales: ['es', 'ca', 'en'] } },
  globals: { footer: { locales: ['es', 'ca'] } },
  provider: fakeProvider(),
  instructions: () => '',
  access: () => true,
  queue: 'translations',
  ...overrides,
})

const endpoint = (
  s: TranslatorSettings,
  path: string,
): ((req: PayloadRequest) => Promise<Response>) =>
  translatorEndpoints(s).find(item => item.path === path)!.handler as never

const request = ({
  body,
  records = [],
  query = '',
  doc = { id: 'e1', title: 'Curso' },
  docsByLocale = {},
  invalidJson = false,
  queueError,
  runError,
  findError,
  createError,
  versions = [],
  collections = {
    events: {
      config: {
        fields: [{ name: 'title', type: 'text', localized: true }],
        versions: { drafts: { autosave: false } },
      },
    },
  },
  globals = [
    { slug: 'footer', fields: [{ name: 'tagline', type: 'text', localized: true }] },
  ],
}: {
  body?: unknown
  records?: Record<string, unknown>[]
  query?: string
  doc?: Record<string, unknown> | null
  docsByLocale?: Record<string, Record<string, unknown>>
  invalidJson?: boolean
  queueError?: Error
  runError?: Error
  findError?: Error
  createError?: Error
  versions?: Record<string, unknown>[]
  collections?: Record<string, unknown>
  globals?: Record<string, unknown>[]
}): {
  req: PayloadRequest
  queue: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  findByID: ReturnType<typeof vi.fn>
  findGlobal: ReturnType<typeof vi.fn>
  find: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  findVersions: ReturnType<typeof vi.fn>
  findGlobalVersions: ReturnType<typeof vi.fn>
  logError: ReturnType<typeof vi.fn>
  logWarn: ReturnType<typeof vi.fn>
} => {
  let jobs = 0
  const queue = queueError
    ? vi.fn().mockRejectedValue(queueError)
    : vi.fn(async () => ({ id: `job-${++jobs}` }))
  const run = runError
    ? vi.fn().mockRejectedValue(runError)
    : vi.fn().mockResolvedValue({})
  const create = createError ? vi.fn().mockRejectedValue(createError) : vi.fn()
  const findByID = vi.fn(async ({ locale }: { locale?: string }) => {
    if (findError) throw findError
    return (locale && docsByLocale[locale]) || doc
  })
  const findGlobal = vi.fn(async () => ({ tagline: 'Lema' }))
  const find = vi.fn(async () => ({ docs: records }))
  const logError = vi.fn()
  const logWarn = vi.fn()
  const update = vi.fn()
  const findVersions = vi.fn(async () => ({ docs: versions }))
  const findGlobalVersions = vi.fn(async () => ({ docs: versions }))
  const req = {
    json: async () => {
      if (invalidJson) throw new SyntaxError('Unexpected token')
      return body
    },
    searchParams: new URLSearchParams(query),
    payload: {
      jobs: { queue, run },
      logger: { error: logError, warn: logWarn },
      collections,
      globals: { config: globals },
      config: { blocks: [], localization: { defaultLocale: 'es' } },
      find,
      findByID,
      findGlobal,
      create,
      update,
      findVersions,
      findGlobalVersions,
    },
  } as unknown as PayloadRequest
  return {
    req,
    queue,
    run,
    create,
    findByID,
    findGlobal,
    find,
    update,
    findVersions,
    findGlobalVersions,
    logError,
    logWarn,
  }
}

const recent = (targetLocale: string, status: string): Record<string, unknown> => ({
  id: `r-${targetLocale}`,
  targetLocale,
  status,
  updatedAt: new Date().toISOString(),
})

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
        fieldPermissions: true,
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

  it('queues the request user’s field permissions from the document access result', async () => {
    const fields = { title: { read: true, update: true } }
    vi.mocked(docAccessOperation).mockResolvedValueOnce({
      fields,
      read: true,
      update: true,
    } as never)
    const { req, queue } = request({
      body: { collection: 'events', id: 'e1', sourceLocale: 'es', targetLocales: ['ca'] },
    })

    await endpoint(settings(), '/translator/translate')(req)

    expect(docAccessOperation).toHaveBeenCalledTimes(1)
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ fieldPermissions: fields }),
      }),
    )
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

describe('GET /translator/status', () => {
  it('does not report fields the requester cannot update as stale', async () => {
    vi.mocked(docAccessOperation).mockResolvedValueOnce({
      fields: { title: { read: true } },
      read: true,
      update: true,
    } as never)
    const { req } = request({
      query: 'collection=events&id=e1',
      records: [
        { ...recent('ca', 'done'), fields: { title: { source: 'old', output: 'old' } } },
      ],
      docsByLocale: { ca: { id: 'e1', title: null } },
    })

    const response = await endpoint(settings(), '/translator/status')(req)
    const body = await response.json()

    expect(body.locales[1]).toMatchObject({ stale: false, changed: 0, missing: 0 })
  })

  it('rejects users the access function denies', async () => {
    const { req } = request({ query: 'collection=events&id=e1' })

    const response = await endpoint(
      settings({ access: () => false }),
      '/translator/status',
    )(req)

    expect(response.status).toBe(403)
  })

  it('answers 404 for a document that does not exist', async () => {
    const { req, findByID } = request({
      query: 'collection=events&id=missing',
      doc: null,
    })

    const response = await endpoint(settings(), '/translator/status')(req)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not-found' })
    expect(findByID).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'missing', disableErrors: true }),
    )
  })

  it('answers 404 when the configured collection is not registered in Payload', async () => {
    const { req } = request({ query: 'collection=events&id=e1', collections: {} })

    const response = await endpoint(settings(), '/translator/status')(req)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not-found' })
  })

  it('reports every locale of the entity, flagging stale translations', async () => {
    const { req } = request({
      query: 'collection=events&id=e1',
      records: [
        {
          id: 'r1',
          targetLocale: 'ca',
          sourceLocale: 'es',
          status: 'done',
          fields: { title: { source: 'old-hash', output: 'x' } },
          kept: ['shortDescription'],
          translatedAt: '2026-10-05T10:00:00.000Z',
          updatedAt: '2026-10-05T10:00:00.000Z',
          error: null,
        },
      ],
    })

    const response = await endpoint(settings(), '/translator/status')(req)
    const body = await response.json()

    expect(body).toEqual({
      enabled: true,
      writesLive: false,
      lastPublishedAt: null,
      locales: [
        {
          locale: 'es',
          state: 'none',
          sourceLocale: null,
          stale: false,
          changed: 0,
          missing: 0,
          error: null,
          translatedAt: null,
          kept: 0,
        },
        {
          locale: 'ca',
          state: 'done',
          sourceLocale: 'es',
          stale: true,
          changed: 1,
          missing: 0,
          error: null,
          translatedAt: '2026-10-05T10:00:00.000Z',
          kept: 1,
        },
        {
          locale: 'en',
          state: 'none',
          sourceLocale: null,
          stale: false,
          changed: 0,
          missing: 0,
          error: null,
          translatedAt: null,
          kept: 0,
        },
      ],
    })
  })

  it('flags as stale a translation whose field someone emptied in the target', async () => {
    const sourceHash = fingerprintOf({
      path: 'title',
      segments: [{ key: 'title' }],
      kind: 'text',
      value: 'Curso',
    })!
    const { req, findByID } = request({
      query: 'collection=events&id=e1',
      records: [
        {
          id: 'r1',
          targetLocale: 'ca',
          status: 'done',
          fields: { title: { source: sourceHash, output: 'x' } },
          translatedAt: '2026-10-05T10:00:00.000Z',
          updatedAt: '2026-10-05T10:00:00.000Z',
          error: null,
        },
      ],
      docsByLocale: { ca: { id: 'e1', title: '' } },
    })

    const response = await endpoint(settings(), '/translator/status')(req)
    const body = await response.json()

    expect(body.locales[1]).toMatchObject({
      locale: 'ca',
      stale: true,
      changed: 0,
      missing: 1,
    })
    expect(findByID).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'ca', fallbackLocale: false }),
    )
  })

  it('measures each locale against the one it was translated from', async () => {
    const hashOf = (value: string): string =>
      fingerprintOf({ path: 'title', segments: [{ key: 'title' }], kind: 'text', value })!
    const fromCatalan = (title: string): Record<string, unknown> => ({
      id: 'r-en',
      targetLocale: 'en',
      sourceLocale: 'ca',
      status: 'done',
      fields: { title: { source: hashOf(title), output: hashOf('[en] Curs') } },
      translatedAt: '2026-10-05T10:00:00.000Z',
      updatedAt: '2026-10-05T10:00:00.000Z',
      error: null,
    })
    const docs = {
      es: { id: 'e1', title: 'Curso cambiado' },
      ca: { id: 'e1', title: 'Curs' },
      en: { id: 'e1', title: '[en] Curs' },
    }

    const upToDate = request({
      query: 'collection=events&id=e1',
      records: [fromCatalan('Curs')],
      docsByLocale: docs,
    })
    const unchanged = await (
      await endpoint(settings(), '/translator/status')(upToDate.req)
    ).json()
    expect(unchanged.locales[2]).toMatchObject({
      locale: 'en',
      sourceLocale: 'ca',
      stale: false,
      changed: 0,
    })
    // The source is read with fallback, as the job does when translating.
    expect(
      upToDate.findByID.mock.calls.some(
        ([args]) => args.locale === 'ca' && args.fallbackLocale !== false,
      ),
    ).toBe(true)

    const outdated = request({
      query: 'collection=events&id=e1',
      records: [fromCatalan('Curs antic')],
      docsByLocale: docs,
    })
    const changed = await (
      await endpoint(settings(), '/translator/status')(outdated.req)
    ).json()
    expect(changed.locales[2]).toMatchObject({ locale: 'en', stale: true, changed: 1 })
  })

  it('reports a collection without drafts as written live', async () => {
    const { req } = request({
      query: 'collection=events&id=e1',
      collections: { events: { config: { fields: [], versions: false } } },
    })

    const response = await endpoint(settings(), '/translator/status')(req)

    expect(await response.json()).toMatchObject({ writesLive: true })
  })

  it('counts changed fields only for finished translations', async () => {
    const { req } = request({
      query: 'collection=events&id=e1',
      records: [
        {
          id: 'r1',
          targetLocale: 'ca',
          status: 'failed',
          fields: { title: { source: 'old-hash', output: 'x' } },
          kept: [],
          translatedAt: null,
          updatedAt: '2026-10-05T10:00:00.000Z',
          error: 'boom',
        },
      ],
    })

    const response = await endpoint(settings(), '/translator/status')(req)
    const body = (await response.json()) as { locales: { changed: number }[] }

    expect(body.locales.map(item => item.changed)).toEqual([0, 0, 0])
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

describe('GET /translator/status after a live write', () => {
  const doneRecord = (
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    id: 'r-ca',
    targetLocale: 'ca',
    status: 'done',
    fields: {},
    kept: [],
    translatedAt: '2026-10-06T10:00:00.000Z',
    revalidatedAt: null,
    updatedAt: '2026-10-06T10:00:00.000Z',
    error: null,
    ...overrides,
  })

  it('tells the site once about what the job published, and remembers it', async () => {
    const onLiveWrite = vi.fn()
    const { req, update } = request({ query: 'global=footer', records: [doneRecord()] })

    const response = await endpoint(settings({ onLiveWrite }), '/translator/status')(req)

    expect(response.status).toBe(200)
    expect(onLiveWrite).toHaveBeenCalledTimes(1)
    expect(onLiveWrite).toHaveBeenCalledWith({
      req,
      entityType: 'global',
      slug: 'footer',
      docId: null,
      locales: ['ca'],
    })
    expect(update).toHaveBeenCalledWith({
      collection: 'translation-records',
      id: 'r-ca',
      data: { revalidatedAt: expect.any(String) },
    })
  })

  it('does not repeat it once revalidated after the translation', async () => {
    const onLiveWrite = vi.fn()
    const { req, update } = request({
      query: 'global=footer',
      records: [doneRecord({ revalidatedAt: '2026-10-06T10:00:05.000Z' })],
    })

    await endpoint(settings({ onLiveWrite }), '/translator/status')(req)

    expect(onLiveWrite).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('calls it again after a newer translation', async () => {
    const onLiveWrite = vi.fn()
    const { req } = request({
      query: 'global=footer',
      records: [doneRecord({ revalidatedAt: '2026-10-06T09:00:00.000Z' })],
    })

    await endpoint(settings({ onLiveWrite }), '/translator/status')(req)

    expect(onLiveWrite).toHaveBeenCalledTimes(1)
  })

  it('never calls it for content with drafts, where nothing was published', async () => {
    const onLiveWrite = vi.fn()
    const { req, update } = request({
      query: 'collection=events&id=e1',
      records: [doneRecord()],
    })

    await endpoint(settings({ onLiveWrite }), '/translator/status')(req)

    expect(onLiveWrite).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('answers the status and records the attempt even when the hook fails', async () => {
    const onLiveWrite = vi.fn().mockRejectedValue(new Error('revalidate failed'))
    const { req, update, logWarn } = request({
      query: 'global=footer',
      records: [doneRecord()],
    })

    const response = await endpoint(settings({ onLiveWrite }), '/translator/status')(req)

    expect(response.status).toBe(200)
    expect(logWarn).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { revalidatedAt: expect.any(String) } }),
    )
  })
})

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

describe('GET /translator/status with an expired run', () => {
  it.each(['queued', 'running'])(
    'reports a %s record older than the busy window as failed and retryable, without writing',
    async status => {
      const { req, update, create } = request({
        query: 'collection=events&id=e1',
        records: [
          {
            id: 'r1',
            targetLocale: 'ca',
            status,
            error: null,
            translatedAt: null,
            updatedAt: '2020-01-01T00:00:00.000Z',
          },
        ],
      })

      const body = await (await endpoint(settings(), '/translator/status')(req)).json()

      expect(body.locales[1]).toMatchObject({
        locale: 'ca',
        state: 'failed',
        error: expect.stringContaining('interrupted'),
      })
      expect(update).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
    },
  )

  it('keeps a recent running record as running', async () => {
    const { req } = request({
      query: 'collection=events&id=e1',
      records: [recent('ca', 'running')],
    })

    const body = await (await endpoint(settings(), '/translator/status')(req)).json()

    expect(body.locales[1]).toMatchObject({ locale: 'ca', state: 'running', error: null })
  })
})

describe('GET /translator/status and the last publication', () => {
  it('reports when a document with drafts was last published', async () => {
    const { req, findVersions } = request({
      query: 'collection=events&id=e1',
      versions: [{ id: 'v1', updatedAt: '2026-10-06T09:00:00.000Z' }],
    })

    const body = await (await endpoint(settings(), '/translator/status')(req)).json()

    expect(body.lastPublishedAt).toBe('2026-10-06T09:00:00.000Z')
    expect(findVersions).toHaveBeenCalledWith({
      collection: 'events',
      where: {
        and: [
          { parent: { equals: 'e1' } },
          { 'version._status': { equals: 'published' } },
        ],
      },
      sort: '-updatedAt',
      limit: 1,
      depth: 0,
    })
  })

  it('reports null for a document never published', async () => {
    const { req } = request({ query: 'collection=events&id=e1' })

    const body = await (await endpoint(settings(), '/translator/status')(req)).json()

    expect(body.lastPublishedAt).toBeNull()
  })

  it('reads the published versions of a global with drafts', async () => {
    const { req, findGlobalVersions } = request({
      query: 'global=footer',
      globals: [
        {
          slug: 'footer',
          fields: [{ name: 'tagline', type: 'text', localized: true }],
          versions: { drafts: true },
        },
      ],
      versions: [{ id: 'v1', updatedAt: '2026-10-06T09:00:00.000Z' }],
    })

    const body = await (await endpoint(settings(), '/translator/status')(req)).json()

    expect(body.lastPublishedAt).toBe('2026-10-06T09:00:00.000Z')
    expect(findGlobalVersions).toHaveBeenCalledWith({
      slug: 'footer',
      where: { 'version._status': { equals: 'published' } },
      sort: '-updatedAt',
      limit: 1,
      depth: 0,
    })
  })

  it('does not look for versions of content without drafts', async () => {
    const { req, findGlobalVersions } = request({ query: 'global=footer' })

    const body = await (await endpoint(settings(), '/translator/status')(req)).json()

    expect(body.lastPublishedAt).toBeNull()
    expect(findGlobalVersions).not.toHaveBeenCalled()
  })

  it('does not read the versions of a document the user cannot read', async () => {
    vi.mocked(docAccessOperation).mockResolvedValueOnce({
      fields: {},
      read: false,
      update: false,
    } as never)
    const { req, findVersions } = request({ query: 'collection=events&id=e1' })

    const response = await endpoint(settings(), '/translator/status')(req)

    expect(response.status).toBe(404)
    expect(findVersions).not.toHaveBeenCalled()
  })
})
