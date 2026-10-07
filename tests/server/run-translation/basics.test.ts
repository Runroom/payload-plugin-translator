import type { Payload } from 'payload'
import { JobCancelledError, NotFound } from 'payload'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import { fingerprint } from '../../../src/core/fingerprint.js'
import { MarkError } from '../../../src/core/lexical.js'
import { fakeProvider } from '../../../src/exports/testing.js'
import { ProviderError } from '../../../src/provider/types.js'
import { requesterPermissions } from '../../../src/server/docAccess.js'
import { AccessDeniedError } from '../../../src/server/errors.js'
import { RECORDS_SLUG } from '../../../src/server/records.js'
import { MISSING_REQUESTER, runTranslation } from '../../../src/server/runTranslation.js'
import type { TranslatorSettings } from '../../../src/server/settings.js'
import { fakePayload, settings, input, statefulPayload, userOf } from './helpers.js'
import type { Docs } from './helpers.js'

// The job checks the requester's document access through Payload, which reads the
// database; here every requester may translate every field unless a test says otherwise.
vi.mock('../../../src/server/docAccess.js', () => ({
  requesterPermissions: vi.fn(async () => true),
}))

describe('runTranslation', () => {
  it('retries a stale failed record created before this job', async () => {
    const { payload, records } = fakePayload({
      docs: { es: { id: 'e1', title: 'Curso' }, ca: { id: 'e1', title: null } },
      record: {
        status: 'failed',
        error: 'old failure',
        updatedAt: '2025-01-01T00:00:00Z',
      },
    })
    await runTranslation({
      isLastAttempt: true,
      payload,
      input,
      settings,
      jobCreatedAt: '2025-02-01T00:00:00Z',
    })
    expect(records.mock.calls.at(-1)![0].data.status).toBe('done')
  })

  it('treats a failed record updated during this job as a previous failure', async () => {
    const { payload } = fakePayload({
      docs: { es: { id: 'e1', title: 'Curso' }, ca: { id: 'e1', title: null } },
      record: {
        status: 'failed',
        error: 'this job failed',
        updatedAt: '2025-02-01T00:00:00Z',
      },
    })
    await expect(
      runTranslation({
        isLastAttempt: true,
        payload,
        input,
        settings,
        jobCreatedAt: '2025-02-01T00:00:00Z',
      }),
    ).rejects.toBeInstanceOf(JobCancelledError)
    expect(payload.findByID).not.toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'events' }),
    )
  })
  it('does not send or write denied fields and preserves their previous hashes', async () => {
    const previousSubtitle = { source: 'previous-source', output: 'previous-output' }
    const { payload, update, records } = fakePayload({
      docs: {
        es: { id: 'e1', title: 'Curso', subtitle: 'Secreto' },
        ca: { id: 'e1', title: null, subtitle: null },
      },
      record: { status: 'done', fields: { subtitle: previousSubtitle } },
    })
    const translate = vi.fn(fakeProvider().translate)
    vi.mocked(requesterPermissions).mockResolvedValueOnce({ title: true })

    await runTranslation({
      isLastAttempt: true,
      payload,
      input,
      settings: { ...settings, provider: { translate } },
    })

    expect(translate).toHaveBeenCalledTimes(1)
    expect(Object.values(translate.mock.calls[0]![0].units)).toEqual(['Curso'])
    expect(update.mock.calls[0]![0].data).toEqual({ title: '[ca] Curso' })
    expect(records.mock.calls.at(-1)![0].data.fields).toMatchObject({
      subtitle: previousSubtitle,
      title: expect.any(Object),
    })
  })

  it('drops the hashes of paths that no longer exist even with field permissions', async () => {
    const gone = { source: 'gone-source', output: 'gone-output' }
    const { payload, records } = fakePayload({
      docs: {
        es: { id: 'e1', title: 'Curso' },
        ca: { id: 'e1', title: null },
      },
      record: { status: 'done', fields: { 'agenda.days.d9.label': gone } },
    })
    vi.mocked(requesterPermissions).mockResolvedValueOnce({ title: true })

    await runTranslation({ isLastAttempt: true, payload, input, settings })

    expect(records.mock.calls.at(-1)![0].data.fields).not.toHaveProperty(
      'agenda.days.d9.label',
    )
  })

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

  it('copies a rich text with only an upload to the target without calling the provider', async () => {
    const gallery = {
      root: {
        type: 'root',
        children: [{ type: 'upload', relationTo: 'media', value: 'm1', fields: null }],
      },
    }
    const { payload, update, records } = fakePayload({
      docs: { es: { id: 'e1', gallery }, ca: { id: 'e1', gallery: null } },
      collections: {
        events: {
          config: {
            fields: [{ name: 'gallery', type: 'richText', localized: true }],
            versions: { drafts: { autosave: false } },
          },
        },
      },
    })
    const translate = vi.fn(fakeProvider().translate)

    await runTranslation({
      isLastAttempt: true,
      payload,
      input,
      settings: { ...settings, provider: { translate } },
    })

    expect(translate).not.toHaveBeenCalled()
    expect(update.mock.calls[0]![0].data).toEqual({ gallery })
    const last = records.mock.calls.at(-1)![0]
    expect(last.data.status).toBe('done')
    expect(last.data.fields.gallery.output).toBe(last.data.fields.gallery.source)
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
    payload.findByID = vi.fn(async (args: { collection?: string }) => {
      const user = userOf(args)
      if (!user) throw new NotFound()
      return user
    }) as never

    await expect(
      runTranslation({ isLastAttempt: true, payload, input, settings }),
    ).rejects.toBeInstanceOf(JobCancelledError)
    expect(records.mock.calls.at(-1)![0].data.status).toBe('failed')
  })

  it('cancels every locale when the requester no longer exists', async () => {
    const { payload, records } = fakePayload(pending)
    const translate = vi.fn(fakeProvider().translate)

    await expect(
      runTranslation({
        isLastAttempt: true,
        payload,
        input: { ...input, requester: { collection: 'users', id: 'gone' } },
        settings: { ...settings, provider: { translate } },
      }),
    ).rejects.toThrow(MISSING_REQUESTER)
    expect(records.mock.calls.at(-1)![0].data).toMatchObject({
      status: 'failed',
      error: MISSING_REQUESTER,
    })
    expect(translate).not.toHaveBeenCalled()
  })

  it('fails the locale for good without calling the provider when access is denied', async () => {
    const { payload, records } = fakePayload(pending)
    const translate = vi.fn(fakeProvider().translate)
    vi.mocked(requesterPermissions).mockRejectedValueOnce(
      new AccessDeniedError('Access denied'),
    )

    await expect(
      runTranslation({
        isLastAttempt: false,
        payload,
        input,
        settings: { ...settings, provider: { translate } },
      }),
    ).rejects.toBeInstanceOf(JobCancelledError)
    expect(records.mock.calls.at(-1)![0].data).toMatchObject({
      status: 'failed',
      error: 'Access denied',
    })
    expect(requesterPermissions).toHaveBeenCalledWith({
      payload,
      user: expect.objectContaining({ id: 'u1', collection: 'users' }),
      ref: expect.objectContaining({ collectionSlug: 'events', docId: 'e1' }),
      sourceLocale: 'es',
      targetLocale: 'ca',
    })
    expect(translate).not.toHaveBeenCalled()
  })

  it('reads and writes the document as the requester, with access checks on', async () => {
    const { payload, update } = fakePayload(pending)

    await runTranslation({ isLastAttempt: true, payload, input, settings })

    const user = expect.objectContaining({ id: 'u1', collection: 'users' })
    expect(payload.findByID).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'events', overrideAccess: false, user }),
    )
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'events', overrideAccess: false, user }),
    )
  })

  it('keeps a field Payload refused to write instead of taking it for a concurrent edit', async () => {
    const docs: Docs = {
      es: { id: 'e1', title: 'Curso', subtitle: 'Sub' },
      ca: { id: 'e1', title: null, subtitle: 'Antic' },
    }
    const { payload, update } = statefulPayload(docs)
    type Write = (args: {
      collection: string
      data: Record<string, unknown>
    }) => Promise<unknown>
    const writes = update as Mock<Write>
    const write = writes.getMockImplementation()!
    // Payload keeps the previous value of a field whose row-level `access.update` says no,
    // without an error; the fake drops `subtitle` from the save the same way.
    writes.mockImplementation(async args => {
      if (args.collection === RECORDS_SLUG) return write(args)
      const { subtitle: _refused, ...data } = args.data
      return write({ ...args, data })
    })

    await runTranslation({
      isLastAttempt: false,
      payload,
      input: { ...input, overwriteEdited: true },
      settings,
    })

    expect(docs.ca).toMatchObject({ title: '[ca] Curso', subtitle: 'Antic' })
    const { docs: saved } = await payload.find({
      collection: RECORDS_SLUG as never,
      where: { and: [{ targetLocale: { equals: 'ca' } }] } as never,
    })
    const record = saved[0] as unknown as {
      status: string
      kept: string[]
      fields: Record<string, { output: string | null }>
    }
    expect(record).toMatchObject({ status: 'done', kept: ['subtitle'] })
    expect(record.fields.subtitle).toEqual({ source: expect.any(String), output: null })
    expect(record.fields.title!.output).toEqual(expect.any(String))
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

// The provider saves a correction in the target before answering, as an editor would while
// the translation runs.
const editingTarget = (
  payload: Payload,
  data: Record<string, unknown>,
): TranslatorSettings => {
  const fake = fakeProvider()
  return {
    ...settings,
    provider: {
      translate: async request => {
        await payload.update({
          collection: 'events',
          id: 'e1',
          locale: 'ca',
          data,
        } as never)
        return fake.translate(request)
      },
    },
  }
}

describe('runTranslation and a target edited while the provider runs', () => {
  it('keeps the field the editor filled instead of overwriting it, even when asked to overwrite', async () => {
    const { payload, update, records } = fakePayload({
      docs: { es: { id: 'e1', title: 'Curso' }, ca: { id: 'e1', title: null } },
    })

    await runTranslation({
      isLastAttempt: true,
      payload,
      input: { ...input, overwriteEdited: true },
      settings: editingTarget(payload, { title: 'Curs corregit' }),
    })

    expect(update.mock.calls.map(([args]) => args.data)).toEqual([
      { title: 'Curs corregit' },
    ])
    const data = records.mock.calls.at(-1)![0].data
    expect(data).toMatchObject({ status: 'done', kept: ['title'] })
    expect(data.fields.title).toEqual({ source: fingerprint(['Curso']), output: null })
    expect(data).not.toHaveProperty('translatedAt')
  })

  it('still writes the planned fields the editor did not touch', async () => {
    const { payload, update, records } = fakePayload({
      docs: {
        es: { id: 'e1', title: 'Curso', subtitle: 'Sub' },
        ca: { id: 'e1', title: null, subtitle: null },
      },
    })

    await runTranslation({
      isLastAttempt: true,
      payload,
      input,
      settings: editingTarget(payload, { title: 'Curs corregit' }),
    })

    expect(update.mock.calls.map(([args]) => args.data)).toEqual([
      { title: 'Curs corregit' },
      { subtitle: '[ca] Sub' },
    ])
    const data = records.mock.calls.at(-1)![0].data
    expect(data).toMatchObject({ status: 'done', kept: ['title'] })
    expect(data.fields).toEqual({
      title: { source: fingerprint(['Curso']), output: null },
      subtitle: { source: fingerprint(['Sub']), output: fingerprint(['[ca] Sub']) },
    })
    expect(data.translatedAt).toEqual(expect.any(String))
  })
})
