import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Harness } from './helpers.js'
import {
  boot,
  findRecord,
  firstParagraph,
  localeStatus,
  richParagraph,
  shutdown,
  status,
  translateAndWait,
} from './helpers.js'

// `posts` has drafts: translations are saved as drafts of the target locales.
describe('translating a collection with drafts', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await boot()
  })

  afterAll(async () => {
    await shutdown(harness)
  })

  const createPost = async (title: string): Promise<string> => {
    const post = await harness.payload.create({
      collection: 'posts',
      locale: 'en',
      data: {
        title,
        slug: title.toLowerCase().replaceAll(' ', '-'),
        body: richParagraph({
          plain: 'Read the ',
          bold: 'whole',
          link: 'guide',
          url: 'https://example.com/guide',
        }),
        _status: 'published',
      } as never,
    })
    return String(post.id)
  }

  const readPost = async (
    id: string,
    { locale, draft }: { locale: string; draft: boolean },
  ): Promise<Record<string, unknown>> =>
    (await harness.payload.findByID({
      collection: 'posts',
      id,
      locale: locale as never,
      draft,
      fallbackLocale: false as never,
      depth: 0,
    })) as unknown as Record<string, unknown>

  const editDraft = async (
    id: string,
    { locale, data }: { locale: string; data: Record<string, unknown> },
  ): Promise<void> => {
    await harness.payload.update({
      collection: 'posts',
      id,
      locale: locale as never,
      draft: true,
      data: data as never,
    })
  }

  it('writes the translation to the target draft and leaves the published version alone', async () => {
    const id = await createPost('Hello world')

    await translateAndWait(harness, {
      collection: 'posts',
      id,
      sourceLocale: 'en',
      targetLocales: ['es'],
    })

    const draft = await readPost(id, { locale: 'es', draft: true })
    expect(draft.title).toBe('[es] Hello world')
    expect(draft.slug).toBe('hello-world')
    const [plain, bold, link] = firstParagraph(draft.body)
    expect(plain).toMatchObject({ type: 'text', text: '[es] Read the ', format: 0 })
    expect(bold).toMatchObject({ type: 'text', text: 'whole', format: 1 })
    expect(link).toMatchObject({
      type: 'link',
      fields: { url: 'https://example.com/guide' },
      children: [{ type: 'text', text: 'guide' }],
    })

    const published = await readPost(id, { locale: 'es', draft: false })
    expect(published.title).toBeFalsy()
    expect((await readPost(id, { locale: 'en', draft: false })).title).toBe('Hello world')
    expect((await readPost(id, { locale: 'fr', draft: true })).title).toBeFalsy()

    const record = await findRecord(harness, { docId: id, targetLocale: 'es' })
    expect(record).toMatchObject({ status: 'done', sourceLocale: 'en', error: null })
    expect(Object.keys(record?.fields ?? {})).toEqual(
      expect.arrayContaining(['title', 'body']),
    )

    const reply = await status(harness, { collection: 'posts', id })
    expect(reply.status).toBe(200)
    expect(reply.body.writesLive).toBe(false)
    expect(reply.body.lastPublishedAt).toEqual(expect.any(String))
    expect(localeStatus(reply, 'es')).toMatchObject({
      state: 'done',
      stale: false,
      changed: 0,
      kept: 0,
    })
    expect(localeStatus(reply, 'fr')).toMatchObject({ state: 'none' })
  })

  it('keeps a target text edited by hand unless asked to overwrite it', async () => {
    const id = await createPost('First title')
    const target = { collection: 'posts', id, sourceLocale: 'en', targetLocales: ['es'] }
    await translateAndWait(harness, target)
    await editDraft(id, { locale: 'es', data: { title: 'Título a mano' } })
    await editDraft(id, { locale: 'en', data: { title: 'Second title' } })

    await translateAndWait(harness, target)

    expect((await readPost(id, { locale: 'es', draft: true })).title).toBe(
      'Título a mano',
    )
    const kept = await status(harness, { collection: 'posts', id })
    expect(localeStatus(kept, 'es')?.kept).toBeGreaterThan(0)

    await translateAndWait(harness, { ...target, overwriteEdited: true })

    expect((await readPost(id, { locale: 'es', draft: true })).title).toBe(
      '[es] Second title',
    )
    const overwritten = await status(harness, { collection: 'posts', id })
    expect(localeStatus(overwritten, 'es')).toMatchObject({ kept: 0, stale: false })
  })

  it('reports a translation as stale once its source changes', async () => {
    const id = await createPost('Stale post')
    await translateAndWait(harness, {
      collection: 'posts',
      id,
      sourceLocale: 'en',
      targetLocales: ['es', 'fr'],
    })

    await editDraft(id, {
      locale: 'en',
      data: {
        body: richParagraph({
          plain: 'Skim the ',
          bold: 'short',
          link: 'summary',
          url: 'https://example.com/summary',
        }),
      },
    })

    const reply = await status(harness, { collection: 'posts', id })
    expect(localeStatus(reply, 'es')).toMatchObject({ state: 'done', stale: true })
    expect(localeStatus(reply, 'es')?.changed).toBeGreaterThan(0)
    expect(localeStatus(reply, 'fr')).toMatchObject({ state: 'done', stale: true })
  })
})
