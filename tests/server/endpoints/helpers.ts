import type { PayloadRequest } from 'payload'
import { ValidationError } from 'payload'
import { vi } from 'vitest'

import { fakeProvider } from '../../../src/exports/testing.js'
import { translatorEndpoints } from '../../../src/server/endpoints.js'
import { LOCKS_SLUG } from '../../../src/server/lock.js'
import type { TranslatorSettings } from '../../../src/server/settings.js'

export const settings = (
  overrides: Partial<TranslatorSettings> = {},
): TranslatorSettings => ({
  collections: { events: { locales: ['es', 'ca', 'en'] } },
  globals: { footer: { locales: ['es', 'ca'] } },
  provider: fakeProvider(),
  instructions: () => '',
  access: () => true,
  queue: 'translations',
  runOnRequest: true,
  ...overrides,
})

export const endpoint = (
  s: TranslatorSettings,
  path: string,
): ((req: PayloadRequest) => Promise<Response>) =>
  translatorEndpoints(s).find(item => item.path === path)!.handler as never

export const requester = { id: 'u1', collection: 'users' }

export const request = ({
  body,
  user = requester,
  records = [],
  query = '',
  doc = { id: 'e1', title: 'Curso' },
  docsByLocale = {},
  invalidJson = false,
  queueError,
  runError,
  findError,
  createError,
  lock = null,
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
  user?: { id: string; collection: string } | null
  records?: Record<string, unknown>[]
  query?: string
  doc?: Record<string, unknown> | null
  docsByLocale?: Record<string, Record<string, unknown>>
  invalidJson?: boolean
  queueError?: Error
  runError?: Error
  findError?: Error
  createError?: Error
  // A lock another request holds on the document when this one arrives.
  lock?: { id: string; token: string; updatedAt: string } | null
  versions?: Record<string, unknown>[]
  collections?: Record<string, unknown>
  globals?: Record<string, unknown>[]
}): {
  req: PayloadRequest
  queue: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
  // The records' `create`; the lock's own calls are in `locks` (`delete` is the adapter's
  // `deleteMany`, which releases and takes over locks).
  create: ReturnType<typeof vi.fn>
  locks: { create: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> }
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
  // The unique index refuses a second lock until the first is deleted.
  let held = lock
  const locks = {
    create: vi.fn(async (args: { data: { token: string } }) => {
      if (held) throw new ValidationError({ collection: LOCKS_SLUG, errors: [] })
      held = { id: 'l-new', token: args.data.token, updatedAt: new Date().toISOString() }
      return held
    }),
    delete: vi.fn(async () => {
      held = null
    }),
  }
  const findByID = vi.fn(async ({ locale }: { locale?: string }) => {
    if (findError) throw findError
    return (locale && docsByLocale[locale]) || doc
  })
  const findGlobal = vi.fn(async () => ({ tagline: 'Lema' }))
  const find = vi.fn(async ({ collection }: { collection: string }) =>
    collection === LOCKS_SLUG ? { docs: held ? [held] : [] } : { docs: records },
  )
  const logError = vi.fn()
  const logWarn = vi.fn()
  const update = vi.fn()
  const findVersions = vi.fn(async () => ({ docs: versions }))
  const findGlobalVersions = vi.fn(async () => ({ docs: versions }))
  const req = {
    user,
    locale: 'es',
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
      create: vi.fn(async (args: { collection: string }) =>
        args.collection === LOCKS_SLUG ? locks.create(args as never) : create(args),
      ),
      update,
      db: { deleteMany: locks.delete },
      findVersions,
      findGlobalVersions,
    },
  } as unknown as PayloadRequest
  return {
    req,
    queue,
    run,
    create,
    locks,
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

export const recent = (
  targetLocale: string,
  status: string,
): Record<string, unknown> => ({
  id: `r-${targetLocale}`,
  targetLocale,
  status,
  updatedAt: new Date().toISOString(),
})

// A lock another request took `ageMs` ago.
export const lockedSince = (
  ageMs: number,
): { id: string; token: string; updatedAt: string } => ({
  id: 'l-other',
  token: 'other-token',
  updatedAt: new Date(Date.now() - ageMs).toISOString(),
})
