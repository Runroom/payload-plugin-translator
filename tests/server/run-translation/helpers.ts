import type { Payload } from 'payload'
import { vi } from 'vitest'

import { fakeProvider } from '../../../src/exports/testing.js'
import { RECORDS_SLUG } from '../../../src/server/records.js'
import type { TranslatorSettings } from '../../../src/server/settings.js'

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

export const fakePayload = ({
  docs,
  record = null,
  collections = {
    events: { config: { fields, versions: { drafts: { autosave: false } } } },
  },
}: {
  docs: Docs
  record?: Record<string, unknown> | null
  collections?: Record<string, unknown>
}): {
  payload: Payload
  update: ReturnType<typeof vi.fn>
  records: ReturnType<typeof vi.fn>
} => {
  const update = vi.fn().mockResolvedValue({})
  const records = vi.fn().mockResolvedValue({})
  const state: Docs = { ...docs }
  const payload = {
    collections,
    logger: { error: vi.fn(), warn: vi.fn() },
    config: { blocks: [], localization: { defaultLocale: 'es' } },
    findByID: vi.fn(async ({ locale }: { locale: string }) =>
      structuredClone(state[locale]),
    ),
    find: vi.fn(async () => ({ docs: record ? [{ id: 'r1', ...record }] : [] })),
    create: records,
    update: vi.fn(async (args: { collection: string; locale: string; data: object }) => {
      if (args.collection === RECORDS_SLUG) return records(args)
      await update(args)
      state[args.locale] = { ...state[args.locale], ...args.data }
      return structuredClone(state[args.locale])
    }),
  } as unknown as Payload
  return { payload, update, records }
}

export const settings: TranslatorSettings = {
  collections: { events: { locales: ['es', 'ca', 'en'] } },
  globals: { footer: { locales: ['es', 'ca'] } },
  provider: fakeProvider(),
  instructions: () => '',
  access: () => true,
  queue: 'translations',
}

export const input = {
  entityType: 'collection' as const,
  collectionSlug: 'events',
  docId: 'e1',
  sourceLocale: 'es',
  targetLocales: ['ca'],
  overwriteEdited: false,
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
    async (args: { collection: string; id: string; locale: string; data: object }) => {
      if (args.collection !== RECORDS_SLUG) {
        docs[args.locale] = { ...docs[args.locale], ...args.data }
        return { ...docs[args.locale] }
      }
      const record = saved.find(item => item.id === args.id)!
      Object.assign(record, args.data)
    },
  )
  const payload = {
    collections: {
      events: { config: { fields, versions: { drafts: { autosave: false } } } },
    },
    logger: { error: vi.fn(), warn: vi.fn() },
    config: { blocks: [], localization: { defaultLocale: 'es' } },
    findByID: vi.fn(async ({ locale }: { locale: string }) => ({ ...docs[locale] })),
    find: vi.fn(
      async ({ where }: { where: { and: Record<string, { equals: string }>[] } }) => ({
        docs: saved.filter(item => item.targetLocale === localeOf(where)),
      }),
    ),
    create: vi.fn(async ({ data }: { data: SavedRecord }) => {
      saved.push({ ...data, id: `r-${data.targetLocale}` })
    }),
    update,
  } as unknown as Payload
  return { payload, update }
}
