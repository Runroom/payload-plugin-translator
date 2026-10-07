import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Harness } from './helpers.js'
import { boot, localeStatus, shutdown, status, translateAndWait } from './helpers.js'

describe('translating entities other than drafted documents', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await boot()
  })

  afterAll(async () => {
    await shutdown(harness)
  })

  // `pages` has no drafts, so the translation goes live at once.
  it('writes a collection without drafts live', async () => {
    const page = await harness.payload.create({
      collection: 'pages',
      locale: 'en',
      data: { title: 'About us' } as never,
    })
    const id = String(page.id)

    await translateAndWait(harness, {
      collection: 'pages',
      id,
      sourceLocale: 'en',
      targetLocales: ['es'],
    })

    const live = (await harness.payload.findByID({
      collection: 'pages',
      id,
      locale: 'es',
      fallbackLocale: false as never,
    })) as unknown as { title?: string }
    expect(live.title).toBe('[es] About us')
    const reply = await status(harness, { collection: 'pages', id })
    expect(reply.body).toMatchObject({ writesLive: true, lastPublishedAt: null })
    expect(localeStatus(reply, 'es')).toMatchObject({ state: 'done', stale: false })
  })

  it('translates a global into its draft', async () => {
    await harness.payload.updateGlobal({
      slug: 'footer',
      locale: 'en',
      data: { text: 'All rights reserved', _status: 'published' } as never,
    })

    await translateAndWait(harness, {
      global: 'footer',
      sourceLocale: 'en',
      targetLocales: ['es', 'fr'],
    })

    const read = async (locale: string, draft: boolean): Promise<unknown> =>
      (
        (await harness.payload.findGlobal({
          slug: 'footer',
          locale: locale as never,
          draft,
          fallbackLocale: false as never,
        })) as unknown as { text?: string }
      ).text
    expect(await read('es', true)).toBe('[es] All rights reserved')
    expect(await read('fr', true)).toBe('[fr] All rights reserved')
    expect(await read('es', false)).toBeFalsy()
    const reply = await status(harness, { global: 'footer' })
    expect(reply.body.writesLive).toBe(false)
    expect(localeStatus(reply, 'es')).toMatchObject({ state: 'done', stale: false })
    expect(localeStatus(reply, 'fr')).toMatchObject({ state: 'done', stale: false })
  })
})
