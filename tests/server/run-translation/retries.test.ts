import { JobCancelledError } from 'payload'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import { fakeProvider } from '../../../src/exports/testing.js'
import { ProviderError } from '../../../src/provider/types.js'
import { RECORDS_SLUG } from '../../../src/server/records.js'
import { runTranslation } from '../../../src/server/runTranslation.js'
import type { TranslatorSettings } from '../../../src/server/settings.js'
import { isBusy } from '../../../src/server/status.js'
import {
  fakePayload,
  settings,
  input,
  recordsFor,
  lastRecord,
  bothLocales,
  allTargets,
  failingFor,
  statefulPayload,
} from './helpers.js'
import type { Docs } from './helpers.js'

// The job checks the requester's document access through Payload, which reads the
// database; here every requester may translate every field unless a test says otherwise.
vi.mock('../../../src/server/docAccess.js', () => ({
  requesterPermissions: vi.fn(async () => true),
}))

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
      if (args.collection !== 'events' || raced) return write(args)
      raced = true
      const written = await write(args)
      // A save in another locale reverts the field once our write has returned, so the
      // verification re-read no longer finds it.
      docs.ca = { ...docs.ca, subtitle: null }
      return written
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
