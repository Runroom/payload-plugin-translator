import { describe, expect, it, vi } from 'vitest'

import { notifyLiveWrites } from '../../src/server/liveWrites.js'

describe('notifyLiveWrites', () => {
  it('marks only the translation timestamp read before the hook', async () => {
    const translatedAt = '2026-10-01T00:00:00.000Z'
    const update = vi.fn().mockResolvedValue({})
    const req = { payload: { logger: { warn: vi.fn() }, update } } as never
    const record = {
      id: 'r1',
      targetLocale: 'ca',
      status: 'done' as const,
      translatedAt,
      revalidatedAt: null,
      fields: null,
      kept: null,
      error: null,
      updatedAt: translatedAt,
    }
    const hook = vi.fn(async () => {
      record.translatedAt = '2026-10-02T00:00:00.000Z'
    })

    await notifyLiveWrites({
      req,
      settings: { onLiveWrite: hook } as never,
      ref: { entityType: 'collection', collectionSlug: 'events', docId: 'e1' },
      records: [record],
    })

    expect(update.mock.calls[0]![0].data.revalidatedAt).toBe(translatedAt)
  })
})
