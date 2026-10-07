import { JobCancelledError } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import { fakeProvider } from '../../../src/exports/testing.js'
import { ProviderError } from '../../../src/provider/types.js'
import { LOCK_LOST } from '../../../src/server/localeRun.js'
import { LOCKS_SLUG } from '../../../src/server/lock.js'
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

  it('refreshes the lock on every provider batch and before writing', async () => {
    const { payload } = fakePayload({ docs: { ...bothLocales } })

    await runTranslation({ isLastAttempt: false, payload, input, settings })

    const calls = (payload as unknown as { update: { mock: { calls: unknown[][] } } })
      .update.mock.calls
    const refreshes = calls.filter(
      ([args]) => (args as { collection: string }).collection === LOCKS_SLUG,
    )
    expect(refreshes).toHaveLength(2)
    expect(refreshes[0]![0]).toMatchObject({ data: { token: LOCK_TOKEN } })
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
