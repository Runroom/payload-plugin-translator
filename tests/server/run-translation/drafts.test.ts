import type { Payload } from 'payload'
import { JobCancelledError, ValidationError } from 'payload'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import { runTranslation } from '../../../src/server/runTranslation.js'
import {
  fields,
  fakePayload,
  settings,
  input,
  LOCK_TOKEN,
  requester,
  userOf,
  withLock,
} from './helpers.js'

// The job checks the requester's document access through Payload, which reads the
// database; here every requester may translate every field unless a test says otherwise.
vi.mock('../../../src/server/docAccess.js', () => ({
  requesterPermissions: vi.fn(async () => true),
}))

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
    // No `beginTransaction`: the write and its record are saved one by one, as on an
    // adapter without transactions.
    db: {},
    config: { blocks: [], localization: { defaultLocale: 'es' } },
    findByID: vi.fn(async (args: { collection?: string }) => userOf(args)),
    findGlobal,
    updateGlobal,
    find: vi.fn(withLock(async () => ({ docs: [] }))),
    create: records,
    update: vi.fn(withLock(records)),
    delete: vi.fn(),
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
  requester,
  lockToken: LOCK_TOKEN,
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
      overrideAccess: false,
      user: expect.objectContaining({ id: 'u1', collection: 'users' }),
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
