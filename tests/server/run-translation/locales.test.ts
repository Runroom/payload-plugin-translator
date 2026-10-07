import { JobCancelledError } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import { fingerprint } from '../../../src/core/fingerprint.js'
import { MarkError } from '../../../src/core/lexical.js'
import { fakeProvider } from '../../../src/exports/testing.js'
import { ProviderError } from '../../../src/provider/types.js'
import { RECORDS_SLUG } from '../../../src/server/records.js'
import { runTranslation } from '../../../src/server/runTranslation.js'
import type { TranslatorSettings } from '../../../src/server/settings.js'
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
