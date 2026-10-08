import type { Payload } from 'payload'
import { vi } from 'vitest'

import { fakeProvider } from '../../../src/exports/testing.js'
import { LOCKS_SLUG } from '../../../src/server/lock.js'
import { RECORDS_SLUG } from '../../../src/server/records.js'
import type { TranslatorSettings } from '../../../src/server/settings.js'

/** The token of the lock `input` carries; the fake payloads hold that lock for the job. */
export const LOCK_TOKEN = 'lock-token'

export type LockDoc = { id: string; token: string; updatedAt: string }

export const heldLock = (token = LOCK_TOKEN): LockDoc => ({
  id: 'l1',
  token,
  updatedAt: new Date().toISOString(),
})

type Call = { collection?: string }

// Answers the lock collection's `find` and `update` with `lock` (the conditional update
// matches only when its token is the job's) and routes every other call to `fallback`.
export const withLock =
  <A, R>(
    fallback: (args: A) => Promise<R>,
    lock: LockDoc | null = heldLock(),
  ): ((args: A) => Promise<R | { docs: LockDoc[]; errors: never[] }>) =>
  async args => {
    const call = args as Call & { where?: { and?: { token?: { equals: string } }[] } }
    if (call.collection !== LOCKS_SLUG) return fallback(args)
    const token = call.where?.and?.map(item => item.token?.equals).find(Boolean)
    const held = lock && (token === undefined || token === lock.token) ? [lock] : []
    return { docs: held, errors: [] }
  }

// The adapter's conditional refresh: the lock when its token is the job's, else `null`.
export const refreshOf =
  (lock: LockDoc | null) =>
  async (args: {
    where: { and: { token?: { equals: string } }[] }
  }): Promise<LockDoc | null> => {
    const token = args.where.and.map(item => item.token?.equals).find(Boolean)
    return lock && token === lock.token ? lock : null
  }

export const fields = [
  { name: 'title', type: 'text', localized: true },
  { name: 'subtitle', type: 'text', localized: true },
  { name: 'slug', type: 'text' },
  {
    name: 'agenda',
    type: 'group',
    fields: [
      {
        name: 'days',
        type: 'array',
        fields: [{ name: 'label', type: 'text', localized: true }],
      },
    ],
  },
]

export type Docs = Record<string, Record<string, unknown>>

export const requester = { collection: 'users', id: 'u1' }

// What `payload.findByID` answers for the requester; `null` for a document.
export const userOf = (args: {
  collection?: string
  id?: string
}): Record<string, unknown> | null =>
  args.collection === requester.collection && args.id === requester.id
    ? { id: requester.id, email: 'u1@x' }
    : null

export const fakePayload = ({
  docs,
  record = null,
  lock = heldLock(),
  collections = {
    events: { config: { fields, versions: { drafts: { autosave: false } } } },
  },
}: {
  docs: Docs
  record?: Record<string, unknown> | null
  // The lock in the database; by default the one the job owns.
  lock?: LockDoc | null
  collections?: Record<string, unknown>
}): {
  payload: Payload
  update: ReturnType<typeof vi.fn>
  records: ReturnType<typeof vi.fn>
  unlock: ReturnType<typeof vi.fn>
} => {
  const update = vi.fn().mockResolvedValue({})
  const records = vi.fn().mockResolvedValue({})
  const unlock = vi.fn().mockResolvedValue({})
  const state: Docs = { ...docs }
  const payload = {
    collections,
    logger: { error: vi.fn(), warn: vi.fn() },
    // No `beginTransaction`: the write and its record are saved one by one, as on an
    // adapter without transactions. The lock is refreshed and released through the adapter.
    db: { updateOne: vi.fn(refreshOf(lock)), deleteMany: unlock },
    config: { blocks: [], localization: { defaultLocale: 'es' } },
    findByID: vi.fn(
      async (args: { collection?: string; locale: string }) =>
        userOf(args) ?? structuredClone(state[args.locale]),
    ),
    find: vi.fn(
      withLock(async () => ({ docs: record ? [{ id: 'r1', ...record }] : [] }), lock),
    ),
    create: records,
    update: vi.fn(
      withLock(async (args: { collection: string; locale: string; data: object }) => {
        if (args.collection === RECORDS_SLUG) return records(args)
        await update(args)
        state[args.locale] = { ...state[args.locale], ...args.data }
        return structuredClone(state[args.locale])
      }, lock),
    ),
  } as unknown as Payload
  return { payload, update, records, unlock }
}

// A concurrent save that reverts `locale` once the job has read back its own write: the
// read-back still finds the write, the verification re-read after it finds `reverted`.
export const revertedAfterReadBack = <A extends { locale?: string }>(
  read: (args: A) => Promise<unknown>,
  {
    locale,
    written,
    reverted,
  }: { locale: string; written: () => boolean; reverted: unknown },
): ((args: A) => Promise<unknown>) => {
  let readBack = false
  return async args => {
    if (args.locale !== locale || !written() || !readBack) {
      if (args.locale === locale && written()) readBack = true
      return read(args)
    }
    return reverted
  }
}

export const settings: TranslatorSettings = {
  collections: { events: { locales: ['es', 'ca', 'en'] } },
  globals: { footer: { locales: ['es', 'ca'] } },
  provider: fakeProvider(),
  instructions: () => '',
  access: () => true,
  queue: 'translations',
  runOnRequest: true,
}

export const input = {
  entityType: 'collection' as const,
  collectionSlug: 'events',
  docId: 'e1',
  sourceLocale: 'es',
  targetLocales: ['ca'],
  overwriteEdited: false,
  requester,
  lockToken: LOCK_TOKEN,
}

export type SavedRecord = Record<string, unknown> & { targetLocale: string }

export const recordsFor = (
  records: ReturnType<typeof vi.fn>,
  locale: string,
): SavedRecord[] =>
  records.mock.calls
    .map(([args]) => args.data as SavedRecord)
    .filter(data => data.targetLocale === locale)

export const lastRecord = (
  records: ReturnType<typeof vi.fn>,
  locale: string,
): SavedRecord => recordsFor(records, locale).at(-1)!

export const bothLocales = {
  ca: { id: 'e1', title: null },
  en: { id: 'e1', title: null },
  es: { id: 'e1', title: 'Curso' },
}
export const allTargets = { ...input, targetLocales: ['ca', 'en'] }

export const failingFor = (locale: string, error: Error): TranslatorSettings => {
  const fake = fakeProvider()
  return {
    ...settings,
    provider: {
      translate: vi.fn(async request =>
        request.targetLocale === locale ? Promise.reject(error) : fake.translate(request),
      ),
    },
  }
}

// Keeps documents and records between runs so the job retry can be simulated.
export const statefulPayload = (
  docs: Docs,
): { payload: Payload; update: ReturnType<typeof vi.fn> } => {
  const saved: SavedRecord[] = []
  const localeOf = (where: { and: Record<string, { equals: string }>[] }): string =>
    where.and.find(item => 'targetLocale' in item)!.targetLocale!.equals
  const update = vi.fn(
    withLock(
      async (args: { collection: string; id: string; locale: string; data: object }) => {
        if (args.collection !== RECORDS_SLUG) {
          docs[args.locale] = { ...docs[args.locale], ...args.data }
          return { ...docs[args.locale] }
        }
        const record = saved.find(item => item.id === args.id)!
        Object.assign(record, args.data)
      },
    ),
  )
  const payload = {
    collections: {
      events: { config: { fields, versions: { drafts: { autosave: false } } } },
    },
    logger: { error: vi.fn(), warn: vi.fn() },
    // No `beginTransaction`: the write and its record are saved one by one, as on an
    // adapter without transactions.
    db: { updateOne: vi.fn(refreshOf(heldLock())), deleteMany: vi.fn() },
    config: { blocks: [], localization: { defaultLocale: 'es' } },
    findByID: vi.fn(
      async (args: { collection?: string; locale: string }) =>
        userOf(args) ?? { ...docs[args.locale] },
    ),
    find: vi.fn(
      withLock(
        async ({ where }: { where: { and: Record<string, { equals: string }>[] } }) => ({
          docs: saved.filter(item => item.targetLocale === localeOf(where)),
        }),
      ),
    ),
    create: vi.fn(async ({ data }: { data: SavedRecord }) => {
      saved.push({ ...data, id: `r-${data.targetLocale}` })
    }),
    update,
  } as unknown as Payload
  return { payload, update }
}
