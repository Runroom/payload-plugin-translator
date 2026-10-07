import { createLocalReq, docAccessOperation, docAccessOperationGlobal } from 'payload'
import type { Payload, TypedUser } from 'payload'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { docPermissions, requesterPermissions } from '../../src/server/docAccess.js'
import { AccessDeniedError } from '../../src/server/errors.js'

// Payload resolves document permissions against the database; here each test decides
// them per locale, and a local request is just its user and locale.
vi.mock('payload', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLocalReq: vi.fn(async ({ user, locale }, payload) => ({ user, locale, payload })),
  docAccessOperation: vi.fn(),
  docAccessOperationGlobal: vi.fn(),
}))

const payload = {
  collections: { events: { config: { slug: 'events' } } },
  globals: { config: [{ slug: 'footer' }] },
} as unknown as Payload

const user = { id: 'u1', collection: 'users' } as unknown as TypedUser

const ref = { entityType: 'collection' as const, collectionSlug: 'events', docId: 'e1' }

type Perms = { read?: true; update?: true; fields: unknown }

const perLocale = (byLocale: Record<string, Perms>): void => {
  vi.mocked(docAccessOperation).mockImplementation(
    async ({ req }) => byLocale[(req as { locale: string }).locale] as never,
  )
}

beforeEach(() => {
  vi.mocked(docAccessOperation).mockReset()
  vi.mocked(docAccessOperationGlobal).mockReset()
})

describe('docPermissions', () => {
  it('evaluates the access in the given locale and restores the request afterwards', async () => {
    const req = { payload, locale: 'en', user } as never
    const seen: string[] = []
    vi.mocked(docAccessOperation).mockImplementation(async args => {
      seen.push((args.req as { locale: string }).locale)
      return { read: true, fields: true } as never
    })

    const result = await docPermissions({ req, ref, locale: 'fr' })

    expect(seen).toEqual(['fr'])
    expect((req as { locale: string }).locale).toBe('en')
    expect(result).toEqual({ read: true, update: false, fields: true })
  })

  it('restores the fallback locale the nested read rewrote', async () => {
    const req = { payload, locale: 'en', fallbackLocale: 'en', user } as never
    // `docAccessOperation` reads the document through `createLocalReq`, which sets the
    // request's fallback locale from the locale it reads in.
    vi.mocked(docAccessOperation).mockImplementation(async args => {
      ;(args.req as { fallbackLocale: unknown }).fallbackLocale = null
      return { read: true, fields: true } as never
    })

    await docPermissions({ req, ref, locale: 'fr' })

    expect(req).toMatchObject({ locale: 'en', fallbackLocale: 'en' })
  })

  it('restores the request locale even when the check throws', async () => {
    const req = { payload, locale: 'en', user } as never
    vi.mocked(docAccessOperation).mockRejectedValue(new Error('db down'))

    await expect(docPermissions({ req, ref, locale: 'fr' })).rejects.toThrow('db down')
    expect((req as { locale: string }).locale).toBe('en')
  })

  it('checks a global through its own operation', async () => {
    vi.mocked(docAccessOperationGlobal).mockResolvedValue({
      read: true,
      update: true,
      fields: {},
    } as never)
    const req = { payload, user } as never

    const result = await docPermissions({
      req,
      ref: { entityType: 'global', collectionSlug: 'footer', docId: 'global' },
      locale: 'es',
    })

    expect(result).toEqual({ read: true, update: true, fields: {} })
    expect(docAccessOperationGlobal).toHaveBeenCalledWith({
      req,
      globalConfig: { slug: 'footer' },
    })
  })
})

describe('requesterPermissions', () => {
  it('builds one request per locale as the requester and checks read on the source, update on the target', async () => {
    perLocale({
      es: { read: true, fields: { title: true, note: true } },
      ca: { update: true, fields: { title: true } },
    })

    const fields = await requesterPermissions({
      payload,
      user,
      ref,
      sourceLocale: 'es',
      targetLocale: 'ca',
    })

    expect(fields).toEqual({ title: true })
    expect(createLocalReq).toHaveBeenCalledWith({ user, locale: 'es' }, payload)
    expect(createLocalReq).toHaveBeenCalledWith({ user, locale: 'ca' }, payload)
  })

  it('denies when the source is not readable in its locale', async () => {
    perLocale({
      es: { update: true, fields: true },
      ca: { read: true, update: true, fields: true },
    })

    await expect(
      requesterPermissions({
        payload,
        user,
        ref,
        sourceLocale: 'es',
        targetLocale: 'ca',
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError)
  })

  it('denies when the target is not updatable in its locale', async () => {
    perLocale({
      es: { read: true, update: true, fields: true },
      ca: { read: true, fields: true },
    })

    await expect(
      requesterPermissions({
        payload,
        user,
        ref,
        sourceLocale: 'es',
        targetLocale: 'ca',
      }),
    ).rejects.toThrow('Access denied')
  })
})
