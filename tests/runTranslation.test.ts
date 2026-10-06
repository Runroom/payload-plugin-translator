import type { Payload } from 'payload'
import { JobCancelledError, NotFound, ValidationError } from 'payload'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import { fingerprint } from '../src/core/fingerprint.js'
import { MarkError } from '../src/core/lexical.js'
import { fakeProvider } from '../src/provider/fake.js'
import { ProviderError } from '../src/provider/types.js'
import { RECORDS_SLUG } from '../src/server/records.js'
import { runTranslation } from '../src/server/runTranslation.js'
import type { TranslatorSettings } from '../src/server/settings.js'
import { isBusy } from '../src/server/status.js'

const fields = [
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

type Docs = Record<string, Record<string, unknown>>

const fakePayload = ({
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

const settings: TranslatorSettings = {
  collections: { events: { locales: ['es', 'ca', 'en'] } },
  globals: { footer: { locales: ['es', 'ca'] } },
  provider: fakeProvider(),
  instructions: () => '',
  access: () => true,
  queue: 'translations',
}

const input = {
  entityType: 'collection' as const,
  collectionSlug: 'events',
  docId: 'e1',
  sourceLocale: 'es',
  targetLocales: ['ca'],
  overwriteEdited: false,
}

describe('runTranslation', () => {
  it('writes the translation as a draft in the target locale with the translator context', async () => {
    const { payload, update } = fakePayload({
      docs: {
        es: {
          id: 'e1',
          title: 'Curso',
          slug: 'curso',
          agenda: { days: [{ id: 'd1', label: 'Día 1' }] },
        },
        ca: {
          id: 'e1',
          title: null,
          slug: 'curso',
          agenda: { days: [{ id: 'd1', label: null }] },
        },
      },
    })

    await runTranslation({ isLastAttempt: true, payload, input, settings })

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'events',
        id: 'e1',
        locale: 'ca',
        draft: true,
        context: expect.objectContaining({ runroomTranslator: true }),
        data: {
          title: '[ca] Curso',
          agenda: { days: [{ id: 'd1', label: '[ca] Día 1' }] },
        },
      }),
    )
  })

  it('reads both locales from the latest draft, the target without fallback', async () => {
    const { payload } = fakePayload({
      docs: { es: { id: 'e1', title: 'Curso' }, ca: { id: 'e1', title: null } },
    })

    await runTranslation({ isLastAttempt: true, payload, input, settings })

    expect(payload.findByID).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'es', draft: true, depth: 0 }),
    )
    expect(payload.findByID).toHaveBeenCalledWith(
      expect.objectContaining({
        locale: 'ca',
        draft: true,
        depth: 0,
        fallbackLocale: false,
      }),
    )
  })

  it('records the hashes of what it wrote and marks the record done', async () => {
    const { payload, records } = fakePayload({
      docs: { es: { id: 'e1', title: 'Curso' }, ca: { id: 'e1', title: null } },
    })

    await runTranslation({ isLastAttempt: true, payload, input, settings })

    const last = records.mock.calls.at(-1)![0]
    expect(last.data.status).toBe('done')
    expect(last.data.fields.title.source).toMatch(/^[a-f0-9]{64}$/)
    expect(last.data.fields.title.output).toMatch(/^[a-f0-9]{64}$/)
  })

  it('does not write the document when nothing needs translating', async () => {
    const { payload, update } = fakePayload({
      docs: { es: { id: 'e1', title: 'Curso' }, ca: { id: 'e1', title: 'Curs editat' } },
    })

    await runTranslation({ isLastAttempt: true, payload, input, settings })

    expect(update).not.toHaveBeenCalled()
  })

  it('marks the record failed and cancels the job on a non-retryable provider error', async () => {
    const { payload, records } = fakePayload({
      docs: { es: { id: 'e1', title: 'Curso' }, ca: { id: 'e1', title: null } },
    })
    const failing: TranslatorSettings = {
      ...settings,
      provider: {
        translate: vi.fn().mockRejectedValue(new ProviderError('invalid key', false)),
      },
    }

    await expect(
      runTranslation({ isLastAttempt: true, payload, input, settings: failing }),
    ).rejects.toBeInstanceOf(JobCancelledError)
    expect(records.mock.calls.at(-1)![0].data).toMatchObject({
      status: 'failed',
      error: 'invalid key',
    })
  })

  const failedProvider = (error: Error): TranslatorSettings => ({
    ...settings,
    provider: { translate: vi.fn().mockRejectedValue(error) },
  })
  const pending = {
    docs: { es: { id: 'e1', title: 'Curso' }, ca: { id: 'e1', title: null } },
  }

  it('keeps the original error and cancellation when saving the failed record also fails', async () => {
    const { payload, records } = fakePayload(pending)
    records.mockResolvedValueOnce({}).mockRejectedValue(new Error('db down'))

    await expect(
      runTranslation({
        isLastAttempt: true,
        payload,
        input,
        settings: failedProvider(new ProviderError('invalid key', false)),
      }),
    ).rejects.toBeInstanceOf(JobCancelledError)
    expect(payload.logger.error).toHaveBeenCalled()
  })

  it('rethrows the original error when saving the failed record also fails', async () => {
    const { payload, records } = fakePayload(pending)
    const original = new ProviderError('cuota', true)
    records.mockResolvedValueOnce({}).mockRejectedValue(new Error('db down'))

    await expect(
      runTranslation({
        isLastAttempt: true,
        payload,
        input,
        settings: failedProvider(original),
      }),
    ).rejects.toBe(original)
  })

  it('rethrows a retryable provider error as is and marks the record failed', async () => {
    const { payload, records } = fakePayload(pending)
    const original = new ProviderError('cuota', true)

    await expect(
      runTranslation({
        isLastAttempt: true,
        payload,
        input,
        settings: failedProvider(original),
      }),
    ).rejects.toBe(original)
    expect(records.mock.calls.at(-1)![0].data).toMatchObject({
      status: 'failed',
      error: 'cuota',
    })
  })

  it('cancels and marks the record failed when there is no provider', async () => {
    const { payload, records } = fakePayload(pending)

    await expect(
      runTranslation({
        isLastAttempt: true,
        payload,
        input,
        settings: { ...settings, provider: null },
      }),
    ).rejects.toBeInstanceOf(JobCancelledError)
    expect(records.mock.calls.at(-1)![0].data).toMatchObject({ status: 'failed' })
  })

  it('cancels instead of retrying on a mark error', async () => {
    const { payload, records } = fakePayload(pending)

    await expect(
      runTranslation({
        isLastAttempt: true,
        payload,
        input,
        settings: failedProvider(new MarkError('Marca <0> inesperada')),
      }),
    ).rejects.toBeInstanceOf(JobCancelledError)
    expect(records.mock.calls.at(-1)![0].data).toMatchObject({
      status: 'failed',
      error: 'Marca <0> inesperada',
    })
  })

  it('cancels instead of retrying when the document no longer exists', async () => {
    const { payload, records } = fakePayload(pending)
    payload.findByID = vi.fn().mockRejectedValue(new NotFound())

    await expect(
      runTranslation({ isLastAttempt: true, payload, input, settings }),
    ).rejects.toBeInstanceOf(JobCancelledError)
    expect(records.mock.calls.at(-1)![0].data.status).toBe('failed')
  })

  it('cancels when the collection is not registered in Payload', async () => {
    const { payload, records } = fakePayload({ ...pending, collections: {} })

    await expect(
      runTranslation({ isLastAttempt: true, payload, input, settings }),
    ).rejects.toBeInstanceOf(JobCancelledError)
    expect(records.mock.calls.at(-1)![0].data.status).toBe('failed')
  })

  it('marks the record failed before cancelling when the collection is not translatable', async () => {
    const { payload, records } = fakePayload(pending)

    await expect(
      runTranslation({
        isLastAttempt: true,
        payload,
        input,
        settings: { ...settings, collections: {} },
      }),
    ).rejects.toBeInstanceOf(JobCancelledError)
    expect(records.mock.calls.at(-1)![0].data).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('events'),
    })
  })

  it('stores the exact fingerprints of source and translation', async () => {
    const { payload, records } = fakePayload(pending)

    await runTranslation({ isLastAttempt: true, payload, input, settings })

    expect(records.mock.calls.at(-1)![0].data.fields.title).toEqual({
      source: fingerprint(['Curso']),
      output: fingerprint(['[ca] Curso']),
    })
  })

  it('merges unchanged, kept and translated hashes into the final record', async () => {
    const previous = {
      title: { source: fingerprint(['Curso']), output: fingerprint(['[ca] Curso']) },
    }
    const { payload, records } = fakePayload({
      docs: {
        es: {
          id: 'e1',
          title: 'Curso',
          subtitle: 'Sub',
          agenda: { days: [{ id: 'd1', label: 'Día 1' }] },
        },
        ca: {
          id: 'e1',
          title: '[ca] Curso',
          subtitle: 'Editado',
          agenda: { days: [{ id: 'd1', label: null }] },
        },
      },
      record: { fields: previous },
    })

    await runTranslation({ isLastAttempt: true, payload, input, settings })

    const data = records.mock.calls.at(-1)![0].data
    expect(data.status).toBe('done')
    expect(data.kept).toEqual(['subtitle'])
    expect(Object.keys(data.fields)).toHaveLength(3)
    expect(data.fields.title).toEqual(previous.title)
    expect(data.fields.subtitle).toEqual({ source: fingerprint(['Sub']), output: null })
    expect(Object.values(data.fields)).toContainEqual({
      source: fingerprint(['Día 1']),
      output: fingerprint(['[ca] Día 1']),
    })
  })

  it('marks done with the kept fields when nothing needs translating', async () => {
    const { payload, records, update } = fakePayload({
      docs: { es: { id: 'e1', title: 'Curso' }, ca: { id: 'e1', title: 'Curs editat' } },
    })

    await runTranslation({ isLastAttempt: true, payload, input, settings })

    expect(update).not.toHaveBeenCalled()
    const data = records.mock.calls.at(-1)![0].data
    expect(data.status).toBe('done')
    expect(data.kept).toEqual(['title'])
    expect(data.fields.title.output).toBeNull()
  })
})

type SavedRecord = Record<string, unknown> & { targetLocale: string }

const recordsFor = (records: ReturnType<typeof vi.fn>, locale: string): SavedRecord[] =>
  records.mock.calls
    .map(([args]) => args.data as SavedRecord)
    .filter(data => data.targetLocale === locale)

const lastRecord = (records: ReturnType<typeof vi.fn>, locale: string): SavedRecord =>
  recordsFor(records, locale).at(-1)!

const bothLocales = {
  ca: { id: 'e1', title: null },
  en: { id: 'e1', title: null },
  es: { id: 'e1', title: 'Curso' },
}
const allTargets = { ...input, targetLocales: ['ca', 'en'] }

const failingFor = (locale: string, error: Error): TranslatorSettings => {
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
const statefulPayload = (
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

describe('runTranslation with several target locales', () => {
  it('writes each locale only after the previous write has finished', async () => {
    const { payload, update } = fakePayload({ docs: { ...bothLocales } })
    let release = (): void => {}
    update.mockReturnValueOnce(
      new Promise(resolve => {
        release = (): void => resolve({})
      }),
    )

    const running = runTranslation({
      isLastAttempt: true,
      payload,
      input: allTargets,
      settings,
    })
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(update).toHaveBeenCalledTimes(1)

    release()
    await running

    expect(update.mock.calls.map(([args]) => args.locale)).toEqual(['ca', 'en'])
    expect(update.mock.calls[1]![0].data).toEqual({ title: '[en] Curso' })
  })

  it('finishes the other locales and rethrows when one fails with a retryable error', async () => {
    const { payload, records } = fakePayload({ docs: { ...bothLocales } })
    const original = new ProviderError('cuota', true)

    await expect(
      runTranslation({
        isLastAttempt: true,
        payload,
        input: allTargets,
        settings: failingFor('ca', original),
      }),
    ).rejects.toBe(original)
    expect(recordsFor(records, 'ca').at(-1)).toMatchObject({
      status: 'failed',
      error: 'cuota',
    })
    expect(recordsFor(records, 'en').at(-1)).toMatchObject({ status: 'done' })
  })

  it('prefers retrying when unrecoverable and retryable errors are mixed', async () => {
    const { payload } = fakePayload({ docs: { ...bothLocales } })
    const retryable = new ProviderError('cuota', true)
    const mixed: TranslatorSettings = {
      ...settings,
      provider: {
        translate: vi.fn(async request => {
          throw request.targetLocale === 'ca'
            ? new MarkError('Marca <0> inesperada')
            : retryable
        }),
      },
    }

    await expect(
      runTranslation({
        isLastAttempt: true,
        payload,
        input: allTargets,
        settings: mixed,
      }),
    ).rejects.toBe(retryable)
  })

  it('cancels the job when every failure is unrecoverable', async () => {
    const { payload, records } = fakePayload({ docs: { ...bothLocales } })
    const failing: TranslatorSettings = {
      ...settings,
      provider: {
        translate: vi.fn().mockRejectedValue(new ProviderError('invalid key', false)),
      },
    }

    await expect(
      runTranslation({
        isLastAttempt: true,
        payload,
        input: allTargets,
        settings: failing,
      }),
    ).rejects.toBeInstanceOf(JobCancelledError)
    expect(recordsFor(records, 'ca').at(-1)).toMatchObject({ status: 'failed' })
    expect(recordsFor(records, 'en').at(-1)).toMatchObject({ status: 'failed' })
  })

  it('marks every requested locale failed when the collection is not translatable', async () => {
    const { payload, records } = fakePayload({ docs: { ...bothLocales } })

    await expect(
      runTranslation({
        isLastAttempt: true,
        payload,
        input: allTargets,
        settings: { ...settings, collections: {} },
      }),
    ).rejects.toBeInstanceOf(JobCancelledError)
    expect(recordsFor(records, 'ca').at(-1)).toMatchObject({ status: 'failed' })
    expect(recordsFor(records, 'en').at(-1)).toMatchObject({ status: 'failed' })
  })

  it('does not translate or write again the locale already done when the job is retried', async () => {
    const { payload, update } = statefulPayload({
      es: { ...bothLocales.es },
      ca: { ...bothLocales.ca },
      en: { ...bothLocales.en },
    })
    const original = new ProviderError('cuota', true)
    const firstTry = failingFor('en', original)

    await expect(
      runTranslation({
        isLastAttempt: false,
        payload,
        input: allTargets,
        settings: firstTry,
      }),
    ).rejects.toBe(original)

    const translate = vi.fn(fakeProvider().translate)
    update.mockClear()
    await runTranslation({
      isLastAttempt: true,
      payload,
      input: allTargets,
      settings: { ...settings, provider: { translate } },
    })

    expect(translate.mock.calls.map(([request]) => request.targetLocale)).toEqual(['en'])
    const writes = update.mock.calls
      .map(([args]) => args as { collection: string; locale?: string })
      .filter(args => args.collection !== RECORDS_SLUG)
    expect(writes.map(args => args.locale)).toEqual(['en'])
  })
})

describe('runTranslation retries and safety checks', () => {
  it('leaves the locale queued with the error while the job still has attempts left', async () => {
    const { payload, records } = fakePayload({ docs: { ...bothLocales } })
    const original = new ProviderError('cuota', true)

    await expect(
      runTranslation({
        isLastAttempt: false,
        payload,
        input: allTargets,
        settings: failingFor('ca', original),
      }),
    ).rejects.toBe(original)
    const saved = lastRecord(records, 'ca')
    expect(saved).toMatchObject({ status: 'queued', error: 'cuota' })
    expect(
      isBusy({
        status: saved.status as 'queued',
        updatedAt: new Date().toISOString(),
      }),
    ).toBe(true)
    expect(lastRecord(records, 'en')).toMatchObject({ status: 'done' })
  })

  it('marks the locale failed on the last attempt', async () => {
    const { payload, records } = fakePayload({ docs: { ...bothLocales } })

    await expect(
      runTranslation({
        isLastAttempt: true,
        payload,
        input: allTargets,
        settings: failingFor('ca', new ProviderError('cuota', true)),
      }),
    ).rejects.toThrow('cuota')
    expect(lastRecord(records, 'ca')).toMatchObject({ status: 'failed', error: 'cuota' })
  })

  it('marks an unrecoverable failure failed even with attempts left', async () => {
    const { payload, records } = fakePayload({ docs: { ...bothLocales } })

    await expect(
      runTranslation({
        isLastAttempt: false,
        payload,
        input: allTargets,
        settings: failingFor('ca', new ProviderError('invalid key', false)),
      }),
    ).rejects.toThrow()
    expect(lastRecord(records, 'ca')).toMatchObject({ status: 'failed' })
  })

  it('marks done when the re-read draft holds what was written', async () => {
    const { payload, records } = fakePayload({ docs: { ...bothLocales } })

    await runTranslation({ isLastAttempt: false, payload, input, settings })

    expect(payload.findByID).toHaveBeenLastCalledWith(
      expect.objectContaining({
        locale: 'ca',
        draft: true,
        depth: 0,
        fallbackLocale: false,
      }),
    )
    expect(lastRecord(records, 'ca')).toMatchObject({ status: 'done' })
  })

  it('retries when a concurrent save wiped the translation it just wrote', async () => {
    const { payload, records } = fakePayload({ docs: { ...bothLocales } })
    const original = vi.mocked(payload.findByID)
    payload.findByID = vi.fn(async (args: { locale: string }) =>
      args.locale === 'ca' ? { id: 'e1', title: null } : original(args as never),
    ) as never

    const error = await runTranslation({
      isLastAttempt: false,
      payload,
      input,
      settings,
    }).catch((caught: unknown) => caught)

    expect(error).not.toBeInstanceOf(JobCancelledError)
    expect((error as Error).message).toContain('ca')
    expect(lastRecord(records, 'ca')).toMatchObject({
      status: 'queued',
      error: expect.stringContaining('it will be retried'),
    })
  })

  it.each([
    ['a string', 'ca'],
    ['only the source locale', ['es']],
    ['no locales at all', undefined],
  ])('cancels when targetLocales is %s', async (_label, targetLocales) => {
    const { payload, update } = fakePayload({ docs: { ...bothLocales } })

    await expect(
      runTranslation({
        isLastAttempt: false,
        payload,
        input: { ...input, targetLocales },
        settings,
      }),
    ).rejects.toBeInstanceOf(JobCancelledError)
    expect(update).not.toHaveBeenCalled()
  })

  it('translates each valid locale once, ignoring duplicates and unknown ones', async () => {
    const { payload, update } = fakePayload({ docs: { ...bothLocales } })

    await runTranslation({
      isLastAttempt: false,
      payload,
      input: { ...input, targetLocales: ['ca', 'ca', 'es', 7] },
      settings,
    })

    expect(update.mock.calls.map(([args]) => args.locale)).toEqual(['ca'])
  })

  it('keeps going with the other locales when saving the running record fails', async () => {
    const { payload, records } = fakePayload({ docs: { ...bothLocales } })
    const dbError = new Error('db down')
    records.mockRejectedValueOnce(dbError)

    await expect(
      runTranslation({ isLastAttempt: false, payload, input: allTargets, settings }),
    ).rejects.toBe(dbError)
    expect(lastRecord(records, 'en')).toMatchObject({ status: 'done' })
  })

  it('refreshes the running record after every batch as a heartbeat', async () => {
    const { payload, records } = fakePayload({ docs: { ...bothLocales } })

    await runTranslation({ isLastAttempt: false, payload, input, settings })

    expect(recordsFor(records, 'ca').map(data => data.status)).toEqual([
      'running',
      'running',
      'done',
    ])
  })

  it('says it will retry only when another attempt is left', async () => {
    const { payload, records } = fakePayload({ docs: { ...bothLocales } })
    const original = vi.mocked(payload.findByID)
    payload.findByID = vi.fn(async (args: { locale: string }) =>
      args.locale === 'ca' ? { id: 'e1', title: null } : original(args as never),
    ) as never

    await expect(
      runTranslation({ isLastAttempt: true, payload, input, settings }),
    ).rejects.toThrow('ca')

    const saved = lastRecord(records, 'ca')
    expect(saved.status).toBe('failed')
    expect(saved.error).not.toContain('it will be retried')
  })

  it('keeps the translation going when the heartbeat cannot be saved', async () => {
    const { payload, records } = fakePayload({ docs: { ...bothLocales } })
    records.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('db lenta'))

    await runTranslation({ isLastAttempt: false, payload, input, settings })

    expect(payload.logger.warn).toHaveBeenCalled()
    expect(lastRecord(records, 'ca')).toMatchObject({ status: 'done' })
  })
})

describe('runTranslation against a target that changes while translating', () => {
  const changingDuring = (change: () => void): TranslatorSettings => {
    const fake = fakeProvider()
    return {
      ...settings,
      provider: {
        translate: vi.fn(async request => {
          change()
          return fake.translate(request)
        }),
      },
    }
  }
  const withAgenda = (): Docs => ({
    es: { id: 'e1', title: 'Curso', agenda: { days: [{ id: 'd1', label: 'Día 1' }] } },
    ca: {
      id: 'e1',
      title: null,
      agenda: { days: [{ id: 'd1', date: '2026-11-01', label: null }] },
    },
  })

  it('builds the update from the target as it is right before writing', async () => {
    const docs = withAgenda()
    const { payload, update } = fakePayload({ docs })

    await runTranslation({
      isLastAttempt: false,
      payload,
      input,
      settings: changingDuring(() => {
        docs.ca!.agenda = { days: [{ id: 'd1', date: '2026-12-01', label: null }] }
      }),
    })

    expect(update.mock.calls[0]![0].data.agenda).toEqual({
      days: [{ id: 'd1', date: '2026-12-01', label: '[ca] Día 1' }],
    })
  })

  it('leaves the locale queued for a retry when a row disappears meanwhile', async () => {
    const docs = withAgenda()
    const { payload, update, records } = fakePayload({ docs })

    const error = await runTranslation({
      isLastAttempt: false,
      payload,
      input,
      settings: changingDuring(() => {
        docs.ca!.agenda = { days: [] }
      }),
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(JobCancelledError)
    expect(update).not.toHaveBeenCalled()
    expect(recordsFor(records, 'ca').at(-1)).toMatchObject({ status: 'queued' })
  })

  it('records the fields it verified so a retry does not take them for edited', async () => {
    const docs: Docs = {
      es: { id: 'e1', title: 'Curso', subtitle: 'Sub' },
      ca: { id: 'e1', title: null, subtitle: null },
    }
    const { payload, update } = statefulPayload(docs)
    type Write = (args: { collection: string; data: object }) => Promise<unknown>
    const writes = update as Mock<Write>
    const write = writes.getMockImplementation()!
    let raced = false
    writes.mockImplementation(async args => {
      if (args.collection === RECORDS_SLUG || raced) return write(args)
      raced = true
      const { subtitle: _lost, ...rest } = args.data as Record<string, unknown>
      return write({ ...args, data: rest })
    })

    await expect(
      runTranslation({ isLastAttempt: false, payload, input, settings }),
    ).rejects.toThrow('ca')

    const translate = vi.fn(fakeProvider().translate)
    await runTranslation({
      isLastAttempt: false,
      payload,
      input,
      settings: { ...settings, provider: { translate } },
    })

    expect(translate).toHaveBeenCalledTimes(1)
    expect(Object.values(translate.mock.calls[0]![0].units)).toEqual(['Sub'])
    expect(docs.ca).toMatchObject({ title: '[ca] Curso', subtitle: '[ca] Sub' })
    const { docs: saved } = await payload.find({
      collection: RECORDS_SLUG as never,
      where: { and: [{ targetLocale: { equals: 'ca' } }] } as never,
    })
    expect(saved[0]).toMatchObject({ status: 'done', kept: [] })
  })
})

describe('runTranslation from a locale other than the default', () => {
  const fromCatalan = {
    ...input,
    sourceLocale: 'ca',
    targetLocales: ['es', 'en'],
  }
  const threeLocales = {
    es: { id: 'e1', title: 'Curso' },
    ca: { id: 'e1', title: 'Curs' },
    en: { id: 'e1', title: null },
  }

  it('translates the Catalan text into the other locales, keeping a Spanish text it did not write', async () => {
    const { payload, update, records } = fakePayload({ docs: { ...threeLocales } })

    await runTranslation({ isLastAttempt: true, payload, input: fromCatalan, settings })

    expect(update.mock.calls.map(([args]) => [args.locale, args.data.title])).toEqual([
      ['en', '[en] Curs'],
    ])
    expect(lastRecord(records, 'es')).toMatchObject({
      status: 'done',
      sourceLocale: 'ca',
      kept: ['title'],
    })
    expect(lastRecord(records, 'en')).toMatchObject({
      status: 'done',
      sourceLocale: 'ca',
      kept: [],
    })
  })

  it('overwrites the Spanish text when asked to, and remembers it came from Catalan', async () => {
    const { payload, update, records } = fakePayload({ docs: { ...threeLocales } })

    await runTranslation({
      isLastAttempt: true,
      payload,
      input: { ...fromCatalan, overwriteEdited: true },
      settings,
    })

    expect(update.mock.calls.map(([args]) => [args.locale, args.data.title])).toEqual([
      ['es', '[es] Curs'],
      ['en', '[en] Curs'],
    ])
    expect(lastRecord(records, 'es')).toMatchObject({
      status: 'done',
      sourceLocale: 'ca',
      fields: {
        title: { source: fingerprint(['Curs']), output: fingerprint(['[es] Curs']) },
      },
    })
  })

  it('does not record a source on a locale that failed', async () => {
    const { payload, records } = fakePayload({ docs: { ...threeLocales } })

    await expect(
      runTranslation({
        isLastAttempt: true,
        payload,
        input: { ...fromCatalan, targetLocales: ['en'] },
        settings: failingFor('en', new ProviderError('invalid key', false)),
      }),
    ).rejects.toBeInstanceOf(JobCancelledError)

    expect(lastRecord(records, 'en')).not.toHaveProperty('sourceLocale')
  })

  it('translates a job queued before the source could be chosen from the default locale', async () => {
    const { payload, update, records } = fakePayload({ docs: { ...threeLocales } })
    const { sourceLocale: _legacy, ...legacyInput } = { ...input, targetLocales: ['en'] }

    await runTranslation({ isLastAttempt: true, payload, input: legacyInput, settings })

    expect(update.mock.calls.map(([args]) => [args.locale, args.data.title])).toEqual([
      ['en', '[en] Curso'],
    ])
    expect(lastRecord(records, 'en')).toMatchObject({ sourceLocale: 'es' })
  })

  it('cancels a job whose source locale the entity does not translate between', async () => {
    const { payload, update, records } = fakePayload({ docs: { ...threeLocales } })

    await expect(
      runTranslation({
        isLastAttempt: true,
        payload,
        input: { ...fromCatalan, sourceLocale: 'fr' },
        settings,
      }),
    ).rejects.toBeInstanceOf(JobCancelledError)
    expect(update).not.toHaveBeenCalled()
    expect(lastRecord(records, 'en')).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('fr'),
    })
  })
})

describe('runTranslation without drafts', () => {
  it('writes live a collection whose versions have drafts turned off', async () => {
    const { payload, update } = fakePayload({
      docs: { es: { id: 'p1', title: 'Persona' }, ca: { id: 'p1', title: null } },
      collections: { events: { config: { fields, versions: { drafts: false } } } },
    })

    await runTranslation({ isLastAttempt: true, payload, input, settings })

    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0]![0]).not.toHaveProperty('draft')
  })

  it('cancels instead of retrying when the write fails validation', async () => {
    const { payload, update, records } = fakePayload({
      docs: { es: { id: 'p1', title: 'Persona' }, ca: { id: 'p1', title: null } },
      collections: { events: { config: { fields, versions: false } } },
    })
    update.mockRejectedValue(
      new ValidationError({ errors: [{ message: 'Obligatorio', path: 'label' }] }),
    )

    await expect(
      runTranslation({ isLastAttempt: false, payload, input, settings }),
    ).rejects.toBeInstanceOf(JobCancelledError)
    expect(records.mock.calls.at(-1)![0].data).toMatchObject({ status: 'failed' })
  })

  it('writes and re-reads a collection without drafts directly, never as a draft', async () => {
    const { payload, update } = fakePayload({
      docs: { es: { id: 'p1', title: 'Persona' }, ca: { id: 'p1', title: null } },
      collections: { events: { config: { fields, versions: false } } },
    })

    await runTranslation({ isLastAttempt: true, payload, input, settings })

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'ca', data: { title: '[ca] Persona' } }),
    )
    expect(update.mock.calls[0]![0]).not.toHaveProperty('draft')
    for (const [args] of vi.mocked(payload.findByID).mock.calls) {
      expect(args).not.toHaveProperty('draft')
    }
  })
})

type GlobalState = Record<string, Record<string, unknown>>

type FindGlobal = (args: { locale: string }) => Promise<unknown>

const globalPayload = ({
  state,
  versions,
}: {
  state: GlobalState
  versions: unknown
}): {
  payload: Payload
  updateGlobal: ReturnType<typeof vi.fn>
  findGlobal: Mock<FindGlobal>
  records: ReturnType<typeof vi.fn>
} => {
  const records = vi.fn().mockResolvedValue({})
  const updateGlobal = vi.fn(async (args: { locale: string; data: object }) => {
    state[args.locale] = { ...state[args.locale], ...args.data }
    return structuredClone(state[args.locale])
  })
  const findGlobal = vi.fn<FindGlobal>(async ({ locale }) =>
    structuredClone(state[locale]),
  )
  const payload = {
    collections: {},
    globals: { config: [{ slug: 'footer', fields, versions }] },
    logger: { error: vi.fn(), warn: vi.fn() },
    config: { blocks: [], localization: { defaultLocale: 'es' } },
    findByID: vi.fn(),
    findGlobal,
    updateGlobal,
    find: vi.fn(async () => ({ docs: [] })),
    create: records,
    update: records,
  } as unknown as Payload
  return { payload, updateGlobal, findGlobal, records }
}

const globalInput = {
  entityType: 'global' as const,
  collectionSlug: 'footer',
  docId: 'global',
  sourceLocale: 'es',
  targetLocales: ['ca'],
  overwriteEdited: false,
}

describe('runTranslation for a global', () => {
  const pendingGlobal = (): GlobalState => ({
    es: { title: 'Lema' },
    ca: { title: null },
  })

  it('reads and writes a global with drafts as a draft, the target without fallback', async () => {
    const { payload, updateGlobal, findGlobal } = globalPayload({
      state: pendingGlobal(),
      versions: { drafts: { autosave: { interval: 375 } } },
    })

    await runTranslation({ isLastAttempt: true, payload, input: globalInput, settings })

    expect(findGlobal).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'footer', locale: 'es', draft: true, depth: 0 }),
    )
    expect(findGlobal).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'ca', draft: true, fallbackLocale: false }),
    )
    expect(updateGlobal).toHaveBeenCalledWith({
      slug: 'footer',
      locale: 'ca',
      draft: true,
      depth: 0,
      data: { title: '[ca] Lema' },
      context: expect.objectContaining({ runroomTranslator: true }),
    })
  })

  it('writes a global without drafts directly', async () => {
    const { payload, updateGlobal, findGlobal } = globalPayload({
      state: pendingGlobal(),
      versions: false,
    })

    await runTranslation({ isLastAttempt: true, payload, input: globalInput, settings })

    expect(updateGlobal).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'footer',
        locale: 'ca',
        data: { title: '[ca] Lema' },
      }),
    )
    expect(updateGlobal.mock.calls[0]![0]).not.toHaveProperty('draft')
    for (const [args] of findGlobal.mock.calls) expect(args).not.toHaveProperty('draft')
  })

  it('records the result under the global key', async () => {
    const { payload, records } = globalPayload({
      state: pendingGlobal(),
      versions: false,
    })

    await runTranslation({ isLastAttempt: true, payload, input: globalInput, settings })

    expect(records.mock.calls[0]![0].data).toMatchObject({
      entityType: 'global',
      collectionSlug: 'footer',
      docId: 'global',
      targetLocale: 'ca',
    })
  })

  it('retries when the re-read global does not hold what was written', async () => {
    const { payload, findGlobal, records } = globalPayload({
      state: pendingGlobal(),
      versions: false,
    })
    const original = findGlobal.getMockImplementation()!
    findGlobal.mockImplementation(async args =>
      args.locale === 'ca' ? { title: null } : original(args),
    )

    const error = await runTranslation({
      isLastAttempt: false,
      payload,
      input: globalInput,
      settings,
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(JobCancelledError)
    expect(records.mock.calls.at(-1)![0].data).toMatchObject({ status: 'queued' })
  })

  it('cancels a global the translator is not configured for', async () => {
    const { payload, updateGlobal } = globalPayload({
      state: pendingGlobal(),
      versions: false,
    })

    await expect(
      runTranslation({
        isLastAttempt: true,
        payload,
        input: globalInput,
        settings: { ...settings, globals: {} },
      }),
    ).rejects.toBeInstanceOf(JobCancelledError)
    expect(updateGlobal).not.toHaveBeenCalled()
  })
})

describe('runTranslation and hooks that rewrite what it writes', () => {
  it('fingerprints what Payload saved, so a normalising hook does not look like a concurrent edit', async () => {
    const docs: Docs = {
      es: { id: 'e1', title: 'Curso Intensivo' },
      ca: { id: 'e1', title: null },
    }
    const { payload, update } = statefulPayload(docs)
    type Write = (args: {
      collection: string
      locale: string
      data: object
    }) => Promise<unknown>
    const writes = update as Mock<Write>
    const write = writes.getMockImplementation()!
    // A `beforeChange` that normalizes the value, as `formatSlug` would.
    writes.mockImplementation(async args => {
      if (args.collection === RECORDS_SLUG) return write(args)
      const data = args.data as { title: string }
      return write({ ...args, data: { ...data, title: data.title.toLowerCase() } })
    })

    await runTranslation({ isLastAttempt: false, payload, input, settings })

    expect(docs.ca).toMatchObject({ title: '[ca] curso intensivo' })
    const { docs: saved } = await payload.find({
      collection: RECORDS_SLUG as never,
      where: { and: [{ targetLocale: { equals: 'ca' } }] } as never,
    })
    const record = saved[0] as unknown as {
      status: string
      fields: Record<string, { output: string }>
    }
    expect(record.status).toBe('done')
    expect(record.fields.title?.output).toBe(fingerprint(['[ca] curso intensivo']))

    // On the next pass the normalized text is still ours: nothing to translate.
    const translate = vi.fn(fakeProvider().translate)
    await runTranslation({
      isLastAttempt: false,
      payload,
      input,
      settings: { ...settings, provider: { translate } },
    })
    expect(translate).not.toHaveBeenCalled()
    expect((saved[0] as unknown as { kept: string[] }).kept).toEqual([])
  })
})

describe('runTranslation when nothing needs translating', () => {
  it('keeps the previous translatedAt so the site is not told about a write that did not happen', async () => {
    const hash = fingerprint(['Curso'])!
    const output = fingerprint(['[ca] Curso'])!
    const { payload, records } = fakePayload({
      docs: { es: { id: 'e1', title: 'Curso' }, ca: { id: 'e1', title: '[ca] Curso' } },
      record: {
        status: 'done',
        fields: { title: { source: hash, output } },
        translatedAt: '2026-10-01T10:00:00.000Z',
      },
    })

    await runTranslation({ isLastAttempt: true, payload, input, settings })

    const saved = records.mock.calls.at(-1)![0].data as Record<string, unknown>
    expect(saved.status).toBe('done')
    expect(saved).not.toHaveProperty('translatedAt')
  })
})

describe('runTranslation retried after an unrecoverable failure in one locale', () => {
  it('does not translate again the locale that already failed for good in this job', async () => {
    const { payload } = statefulPayload({
      es: { ...bothLocales.es },
      ca: { ...bothLocales.ca },
      en: { ...bothLocales.en },
    })
    const fake = fakeProvider()
    const translate = vi.fn(async (request: Parameters<typeof fake.translate>[0]) => {
      if (request.targetLocale === 'ca') throw new ProviderError('negado', false)
      if (request.targetLocale === 'en') throw new ProviderError('timeout', true)
      return fake.translate(request)
    })
    const provider = { translate }

    await expect(
      runTranslation({
        isLastAttempt: false,
        payload,
        input: allTargets,
        settings: { ...settings, provider },
      }),
    ).rejects.toMatchObject({ message: 'timeout' })

    translate.mockImplementation(fake.translate)
    await expect(
      runTranslation({
        isLastAttempt: true,
        payload,
        input: allTargets,
        settings: { ...settings, provider },
      }),
    ).rejects.toBeInstanceOf(JobCancelledError)

    expect(translate.mock.calls.map(([request]) => request.targetLocale)).toEqual([
      'ca',
      'en',
      'en',
    ])
    const { docs: saved } = await payload.find({
      collection: RECORDS_SLUG as never,
      where: { and: [{ targetLocale: { equals: 'ca' } }] } as never,
    })
    expect(saved[0]).toMatchObject({ status: 'failed', error: 'negado' })
  })
})
