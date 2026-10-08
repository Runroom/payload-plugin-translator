import type { PayloadRequest } from 'payload'
import { docAccessOperation } from 'payload'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fingerprintOf } from '../../../src/core/fingerprint.js'
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

type Permissions = { fields: unknown; read: boolean; update: boolean }

const open: Permissions = { fields: true, read: true, update: true }

// Document permissions per locale; a locale left out is fully open.
const permissionsByLocale = (byLocale: Record<string, Permissions>): void => {
  vi.mocked(docAccessOperation).mockImplementation(
    async ({ req }) => (byLocale[(req as PayloadRequest).locale!] ?? open) as never,
  )
}

afterEach(() => {
  vi.mocked(docAccessOperation).mockReset()
})

describe('GET /translator/status', () => {
  it('does not report fields the requester cannot update in the target as stale', async () => {
    permissionsByLocale({ ca: { ...open, fields: { title: { read: true } } } })
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

  // The target only feeds counts, so it is read as stored: a field the requester may
  // update there but not read still counts as translated.
  it('reads the source as the requester and the target as stored, checking read access in each', async () => {
    const seen: string[] = []
    vi.mocked(docAccessOperation).mockImplementation(async ({ req }) => {
      seen.push((req as PayloadRequest).locale!)
      return open as never
    })
    const { req, findByID } = request({
      query: 'collection=events&id=e1',
      records: [{ ...recent('ca', 'done'), fields: {} }],
      docsByLocale: { ca: { id: 'e1', title: 'Curs' } },
    })

    await endpoint(settings(), '/translator/status')(req)

    expect(seen).toEqual(['es', 'ca', 'en'])
    expect(findByID).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'es', overrideAccess: false, user: requester }),
    )
    const target = findByID.mock.calls.find(([args]) => args.locale === 'ca')![0]
    expect(target).not.toHaveProperty('user')
    expect(target).not.toHaveProperty('overrideAccess')
  })

  it('reports a locale the requester cannot read without comparison data', async () => {
    permissionsByLocale({ ca: { ...open, read: false } })
    const { req, findByID } = request({
      query: 'collection=events&id=e1',
      records: [
        { ...recent('ca', 'done'), fields: { title: { source: 'old', output: 'old' } } },
        { ...recent('en', 'done'), fields: { title: { source: 'old', output: 'old' } } },
      ],
      docsByLocale: { ca: { id: 'e1', title: null }, en: { id: 'e1', title: null } },
    })

    const response = await endpoint(settings(), '/translator/status')(req)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.locales[1]).toMatchObject({
      locale: 'ca',
      state: 'done',
      stale: false,
      changed: 0,
      missing: 0,
    })
    expect(body.locales[2]).toMatchObject({ locale: 'en', stale: true, changed: 1 })
    expect(findByID).not.toHaveBeenCalledWith(expect.objectContaining({ locale: 'ca' }))
  })

  it('serves the status when only the default locale is unreadable', async () => {
    permissionsByLocale({ es: { ...open, read: false } })
    const { req } = request({
      query: 'collection=events&id=e1',
      records: [
        {
          ...recent('ca', 'done'),
          sourceLocale: 'en',
          fields: { title: { source: 'old', output: 'old' } },
        },
      ],
      docsByLocale: { ca: { id: 'e1', title: null }, en: { id: 'e1', title: 'Course' } },
    })

    const response = await endpoint(settings(), '/translator/status')(req)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.locales[1]).toMatchObject({ locale: 'ca', stale: true, changed: 1 })
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

  it('keeps an old queued record pending while the document lock is live', async () => {
    // A long job refreshes the lock, not the records of the locales still waiting.
    const { req } = request({
      query: 'collection=events&id=e1',
      lock: lockedSince(1_000),
      records: [{ ...recent('ca', 'queued'), updatedAt: '2020-01-01T00:00:00.000Z' }],
    })

    const body = await (await endpoint(settings(), '/translator/status')(req)).json()

    expect(body.locales[1]).toMatchObject({ locale: 'ca', state: 'queued', error: null })
  })

  it('reports an old queued record as interrupted once the lock has expired too', async () => {
    const { req } = request({
      query: 'collection=events&id=e1',
      lock: lockedSince(BUSY_WINDOW_MS + 1),
      records: [{ ...recent('ca', 'queued'), updatedAt: '2020-01-01T00:00:00.000Z' }],
    })

    const body = await (await endpoint(settings(), '/translator/status')(req)).json()

    expect(body.locales[1]).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('interrupted'),
    })
  })

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

  it('does not read the versions of a document the user cannot read in any locale', async () => {
    vi.mocked(docAccessOperation).mockResolvedValue({
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
