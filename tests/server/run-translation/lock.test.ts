import { JobCancelledError } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import { fakeProvider } from '../../../src/exports/testing.js'
import { ProviderError } from '../../../src/provider/types.js'
import { LOCK_LOST } from '../../../src/server/localeRun.js'
import { LOCKS_SLUG } from '../../../src/server/lock.js'
import { RECORDS_SLUG } from '../../../src/server/records.js'
import { runTranslation } from '../../../src/server/runTranslation.js'
import {
  allTargets,
  bothLocales,
  failingFor,
  fakePayload,
  heldLock,
  input,
  LOCK_TOKEN,
  recordsFor,
  settings,
} from './helpers.js'

vi.mock('../../../src/server/docAccess.js', () => ({
  requesterPermissions: vi.fn(async () => true),
}))

type Where = { where: { and: { token?: { equals: string } }[] } }

const releasedWith = (unlock: ReturnType<typeof vi.fn>): string[] =>
  unlock.mock.calls.map(
    ([args]) => (args as Where).where.and.find(item => item.token)!.token!.equals,
  )

describe('runTranslation and the document lock', () => {
  it('cancels as superseded without touching the document, the records or the lock', async () => {
    const { payload, update, records, unlock } = fakePayload({
      docs: { ...bothLocales },
      lock: heldLock('newer-token'),
    })

    await expect(
      runTranslation({ isLastAttempt: false, payload, input: allTargets, settings }),
    ).rejects.toThrow(new JobCancelledError(LOCK_LOST))

    expect(update).not.toHaveBeenCalled()
    expect(records).not.toHaveBeenCalled()
    expect(unlock).not.toHaveBeenCalled()
  })

  it('cancels a job queued without a lock token', async () => {
    const { payload, update } = fakePayload({ docs: { ...bothLocales } })

    await expect(
      runTranslation({
        isLastAttempt: false,
        payload,
        input: { ...input, lockToken: undefined },
        settings,
      }),
    ).rejects.toBeInstanceOf(JobCancelledError)
    expect(update).not.toHaveBeenCalled()
  })

  it('stops writing and leaves the remaining locales alone once the lock is lost mid-run', async () => {
    const lock = heldLock()
    const { payload, update, records } = fakePayload({ docs: { ...bothLocales }, lock })
    const fake = fakeProvider()
    const translate = vi.fn(async (request: Parameters<typeof fake.translate>[0]) => {
      // A newer request takes the lock over while the provider is translating.
      lock.token = 'newer-token'
      return fake.translate(request)
    })

    await expect(
      runTranslation({
        isLastAttempt: false,
        payload,
        input: allTargets,
        settings: { ...settings, provider: { translate } },
      }),
    ).rejects.toBeInstanceOf(JobCancelledError)

    expect(translate).toHaveBeenCalledTimes(1)
    expect(update).not.toHaveBeenCalled()
    // The newer request's records are left alone: only `ca` was set to `running` before.
    expect(recordsFor(records, 'ca').map(data => data.status)).toEqual(['running'])
    expect(recordsFor(records, 'en')).toEqual([])
  })

  it('refreshes the lock at the start, before each record write, on every provider batch and before writing', async () => {
    const { payload } = fakePayload({ docs: { ...bothLocales } })

    await runTranslation({ isLastAttempt: false, payload, input, settings })

    const calls = (payload as unknown as { update: { mock: { calls: unknown[][] } } })
      .update.mock.calls
    const refreshes = calls.filter(
      ([args]) => (args as { collection: string }).collection === LOCKS_SLUG,
    )
    // Start of the attempt, before the `running` record, after the provider batch and
    // before the write.
    expect(refreshes).toHaveLength(4)
    expect(refreshes[0]![0]).toMatchObject({ data: { token: LOCK_TOKEN } })
    // The first refresh comes before anything is read: a plain lookup would leave a lock
    // about to expire open to a take-over during the first provider batch.
    expect(calls[0]![0]).toMatchObject({ collection: LOCKS_SLUG })
    expect(vi.mocked(payload.find)).not.toHaveBeenCalledWith(
      expect.objectContaining({ collection: LOCKS_SLUG }),
    )
  })

  it('does not record a failure once the lock is lost during the provider call', async () => {
    const lock = heldLock()
    const { payload, records } = fakePayload({ docs: { ...bothLocales }, lock })
    // A provider call that outlasted the busy window: a newer request took the lock over
    // and set the records to `queued` for its own job before this call failed.
    const translate = vi.fn(async () => {
      lock.token = 'newer-token'
      throw new ProviderError('timeout', true)
    })

    await expect(
      runTranslation({
        isLastAttempt: false,
        payload,
        input: allTargets,
        settings: { ...settings, provider: { translate } },
      }),
    ).rejects.toThrow(new JobCancelledError(LOCK_LOST))

    expect(recordsFor(records, 'ca').map(data => data.status)).toEqual(['running'])
    expect(recordsFor(records, 'en')).toEqual([])
  })

  it('does not mark the records failed when the lock is lost while the job is prepared', async () => {
    const lock = heldLock()
    const { payload, records } = fakePayload({ docs: { ...bothLocales }, lock })
    const original = vi.mocked(payload.findByID)
    // The requester is gone and, meanwhile, a newer request took the lock over.
    payload.findByID = vi.fn(async (args: { collection?: string }) => {
      if (args.collection !== 'users') return original(args as never)
      lock.token = 'newer-token'
      return null
    }) as never

    await expect(
      runTranslation({ isLastAttempt: false, payload, input: allTargets, settings }),
    ).rejects.toThrow(new JobCancelledError(LOCK_LOST))

    expect(records).not.toHaveBeenCalled()
  })

  it('does not write the running record when the lock is lost before it', async () => {
    const lock = heldLock()
    const { payload, records, update } = fakePayload({ docs: { ...bothLocales }, lock })
    const original = vi.mocked(payload.find)
    payload.find = vi.fn(async (args: { collection: string }) => {
      // The record lookup is the last read before `running` is written.
      if (args.collection === RECORDS_SLUG) lock.token = 'newer-token'
      return original(args as never)
    }) as never

    await expect(
      runTranslation({ isLastAttempt: false, payload, input, settings }),
    ).rejects.toThrow(new JobCancelledError(LOCK_LOST))

    expect(records).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('does not write done for a locale with nothing to translate once the lock is lost', async () => {
    const lock = heldLock()
    const { payload, records, update } = fakePayload({
      docs: { es: { id: 'e1', title: 'Curso' }, ca: { id: 'e1', title: 'Curs editat' } },
      lock,
    })
    const original = vi.mocked(payload.findByID)
    payload.findByID = vi.fn(async (args: { collection?: string }) => {
      // The lock is taken over while the document is read, before the plan comes out empty.
      if (args.collection === 'events') lock.token = 'newer-token'
      return original(args as never)
    }) as never

    await expect(
      runTranslation({ isLastAttempt: false, payload, input, settings }),
    ).rejects.toThrow(new JobCancelledError(LOCK_LOST))

    expect(recordsFor(records, 'ca').map(data => data.status)).toEqual(['running'])
    expect(update).not.toHaveBeenCalled()
  })

  it('releases the lock when the job succeeds', async () => {
    const { payload, unlock } = fakePayload({ docs: { ...bothLocales } })

    await runTranslation({ isLastAttempt: false, payload, input, settings })

    expect(releasedWith(unlock)).toEqual([LOCK_TOKEN])
  })

  it('keeps the lock while a retry is pending and releases it on the last attempt', async () => {
    const retryable = failingFor('ca', new ProviderError('cuota', true))
    const pending = fakePayload({ docs: { ...bothLocales } })
    await expect(
      runTranslation({ isLastAttempt: false, ...pending, input, settings: retryable }),
    ).rejects.toThrow('cuota')
    expect(pending.unlock).not.toHaveBeenCalled()

    const last = fakePayload({ docs: { ...bothLocales } })
    await expect(
      runTranslation({ isLastAttempt: true, ...last, input, settings: retryable }),
    ).rejects.toThrow('cuota')
    expect(releasedWith(last.unlock)).toEqual([LOCK_TOKEN])
  })

  it('releases the lock when the job is cancelled for good', async () => {
    const { payload, unlock } = fakePayload({ docs: { ...bothLocales } })

    await expect(
      runTranslation({
        isLastAttempt: false,
        payload,
        input,
        settings: failingFor('ca', new ProviderError('invalid key', false)),
      }),
    ).rejects.toBeInstanceOf(JobCancelledError)

    expect(releasedWith(unlock)).toEqual([LOCK_TOKEN])
  })
})
