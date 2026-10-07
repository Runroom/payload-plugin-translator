import { describe, expect, it, vi } from 'vitest'

import { runTranslation } from '../../src/server/runTranslation.js'
import type { TranslatorSettings } from '../../src/server/settings.js'
import { translateTask } from '../../src/server/task.js'

vi.mock('../../src/server/runTranslation.js', () => ({
  runTranslation: vi.fn().mockResolvedValue(undefined),
}))

const settings = {} as TranslatorSettings

type Handler = (args: {
  input: Record<string, unknown>
  job: { totalTried: number }
  req: { payload: never }
}) => Promise<unknown>

const task = translateTask(settings) as unknown as {
  handler: Handler
  retries: { attempts: number }
}

const runWith = async (totalTried: number): Promise<boolean> => {
  vi.mocked(runTranslation).mockClear()
  await task.handler({
    input: { collectionSlug: 'events', docId: 'e1', targetLocales: ['ca'] },
    job: { totalTried },
    req: { payload: {} as never },
  })
  return vi.mocked(runTranslation).mock.calls[0]![0].isLastAttempt
}

describe('translateTask', () => {
  it('tells runTranslation whether this run is the last attempt Payload will make', async () => {
    const { attempts } = task.retries

    expect(await runWith(0)).toBe(false)
    expect(await runWith(attempts - 1)).toBe(false)
    expect(await runWith(attempts)).toBe(true)
  })

  it('passes the source locale on as it is, absent on jobs queued before it existed', async () => {
    const sourceOf = async (input: Record<string, unknown>): Promise<unknown> => {
      vi.mocked(runTranslation).mockClear()
      await task.handler({ input, job: { totalTried: 0 }, req: { payload: {} as never } })
      return vi.mocked(runTranslation).mock.calls[0]![0].input.sourceLocale
    }
    const base = { collectionSlug: 'events', docId: 'e1', targetLocales: ['es'] }

    expect(await sourceOf({ ...base, sourceLocale: 'ca' })).toBe('ca')
    expect(await sourceOf(base)).toBeUndefined()
  })

  it('passes the entity type on, reading jobs queued before it existed as collections', async () => {
    const inputOf = async (input: Record<string, unknown>): Promise<unknown> => {
      vi.mocked(runTranslation).mockClear()
      await task.handler({ input, job: { totalTried: 0 }, req: { payload: {} as never } })
      return vi.mocked(runTranslation).mock.calls[0]![0].input.entityType
    }

    expect(
      await inputOf({
        entityType: 'global',
        collectionSlug: 'footer',
        docId: 'global',
        targetLocales: ['ca'],
      }),
    ).toBe('global')
    expect(
      await inputOf({ collectionSlug: 'events', docId: 'e1', targetLocales: ['ca'] }),
    ).toBe('collection')
  })
})

describe('translateTask concurrency', () => {
  it('keys jobs by entity so two jobs of the same document never run at once', () => {
    const { concurrency } = translateTask(settings) as unknown as {
      concurrency: {
        exclusive: boolean
        key: (args: { input: Record<string, unknown>; queue: string }) => string
      }
    }
    const keyOf = (input: Record<string, unknown>): string =>
      concurrency.key({ input, queue: 'translations' })

    expect(concurrency.exclusive).toBe(true)
    expect(
      keyOf({ entityType: 'collection', collectionSlug: 'events', docId: 'e1' }),
    ).toBe('collection:events:e1')
    expect(keyOf({ collectionSlug: 'events', docId: 'e1' })).toBe('collection:events:e1')
    expect(
      keyOf({ entityType: 'global', collectionSlug: 'footer', docId: 'global' }),
    ).toBe('global:footer:global')
    expect(
      keyOf({ entityType: 'collection', collectionSlug: 'events', docId: 'e2' }),
    ).not.toBe(keyOf({ entityType: 'collection', collectionSlug: 'events', docId: 'e1' }))
  })
})
