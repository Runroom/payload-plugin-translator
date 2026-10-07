import type { TypedUser } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { provider } from '../../dev/payload.config.js'
import type { StatusResponse } from '../../src/index.js'
import { MISSING_REQUESTER } from '../../src/server/runTranslation.js'
import type { Harness } from './helpers.js'
import {
  boot,
  callEndpoint,
  findRecord,
  localeStatus,
  QUEUE,
  shutdown,
  status,
  translate,
  translateAndWait,
} from './helpers.js'

type Items = { id: string; text?: string | null; locked?: boolean }[]

type Translate = typeof provider.translate

// A provider answer with another prefix than the fake provider's.
const prefixedBy =
  (prefix: string): Translate =>
  async ({ units }) =>
    Object.fromEntries(
      Object.entries(units).map(([key, text]) => [key, `${prefix}${text}`]),
    )

// `guarded` has access rules that depend on the locale, the user's flags and the row. The
// job runs as the requester, so Payload applies them when it reads and writes.
describe('translating as the requester under access rules', () => {
  let harness: Harness
  const sent = vi.spyOn(provider, 'translate')

  beforeAll(async () => {
    harness = await boot()
  })

  afterEach(() => {
    sent.mockClear()
  })

  afterAll(async () => {
    sent.mockRestore()
    await shutdown(harness)
  })

  const createDoc = async (data: Record<string, unknown>): Promise<string> =>
    String(
      (
        await harness.payload.create({
          collection: 'guarded' as never,
          locale: 'en',
          data: { _status: 'published', ...data } as never,
        })
      ).id,
    )

  const createUser = async (data: Record<string, unknown>): Promise<TypedUser> =>
    (await harness.payload.create({
      collection: 'users',
      data: { password: 'secret-password', ...data } as never,
    })) as unknown as TypedUser

  const readDraft = async (
    id: string,
    locale: string,
  ): Promise<Record<string, unknown>> =>
    (await harness.payload.findByID({
      collection: 'guarded' as never,
      id,
      locale: locale as never,
      draft: true,
      fallbackLocale: false as never,
      depth: 0,
    })) as unknown as Record<string, unknown>

  const createRole = async (slug: string): Promise<string | number> =>
    (
      await harness.payload.create({
        collection: 'roles' as never,
        data: { slug, title: slug } as never,
      })
    ).id

  // Rewrites the rows in `en`; `locked` is not localized, so it applies to every locale.
  const setRows = async (id: string, rows: Items): Promise<void> => {
    await harness.payload.update({
      collection: 'guarded' as never,
      id,
      locale: 'en',
      draft: true,
      data: { items: rows },
    } as never)
  }

  const sentTexts = (): string[] =>
    sent.mock.calls.flatMap(([request]) => Object.values(request.units))

  // Queues the job without running it, so the test can change things before it runs.
  const queueOnly = async (
    body: Parameters<typeof translate>[1],
    user: TypedUser,
  ): Promise<void> => {
    harness.runs.mockResolvedValueOnce({ noJobsRemaining: false } as never)
    const reply = await translate(harness, body, user)
    expect(reply.status).toBe(202)
  }

  // Runs the queue once and clears what is left: a cancelled job stays in the table.
  const runQueueOnce = async (): Promise<void> => {
    await harness.payload.jobs.run({ queue: QUEUE })
    await harness.payload.delete({ collection: 'payload-jobs' as never, where: {} })
  }

  it('refuses the request when a target locale may not be updated, and writes the others', async () => {
    const id = await createDoc({ title: 'Guarded' })
    const body = { collection: 'guarded', id, sourceLocale: 'en' }

    expect(await translate(harness, { ...body, targetLocales: ['es', 'fr'] })).toEqual({
      status: 403,
      body: { error: 'forbidden' },
    })
    expect(await harness.payload.count({ collection: 'payload-jobs' as never })).toEqual({
      totalDocs: 0,
    })

    await translateAndWait(harness, { ...body, targetLocales: ['es'] })

    expect((await readDraft(id, 'es')).title).toBe('[es] Guarded')
    expect((await readDraft(id, 'fr')).title).toBeFalsy()
  })

  it('leaves a locked row alone, keeps it in the record and still finishes the job', async () => {
    const id = await createDoc({
      title: 'Rows',
      items: [
        { text: 'Open', locked: false },
        { text: 'Closed', locked: true },
      ],
    })
    const rows = (await readDraft(id, 'en')).items as Items
    const locked = rows.find(row => row.locked)!
    // A target text the row already holds, so the refusal is visible as "kept".
    await harness.payload.update({
      collection: 'guarded' as never,
      id,
      locale: 'es',
      draft: true,
      data: { items: rows.map(row => ({ ...row, text: row.locked ? 'Cerrado' : null })) },
    } as never)

    await translateAndWait(harness, {
      collection: 'guarded',
      id,
      sourceLocale: 'en',
      targetLocales: ['es'],
      overwriteEdited: true,
    })

    const items = (await readDraft(id, 'es')).items as Items
    expect(items.find(row => !row.locked)?.text).toBe('[es] Open')
    expect(items.find(row => row.locked)?.text).toBe('Cerrado')
    const record = await findRecord(harness, { docId: id, targetLocale: 'es' })
    expect(record).toMatchObject({
      status: 'done',
      error: null,
      kept: [`items.${locked.id}.text`],
    })
    expect(record?.fields?.[`items.${locked.id}.text`]).toEqual({
      source: expect.any(String),
      output: null,
      sourceLocale: 'en',
    })
  })

  it('translates a row again once it is unlocked, and reports it stale while it is locked', async () => {
    const id = await createDoc({ title: 'Relock', items: [{ text: 'Open' }] })
    const body = { collection: 'guarded', id, sourceLocale: 'en', targetLocales: ['es'] }
    await translateAndWait(harness, body)
    const [row] = (await readDraft(id, 'en')).items as Items
    if (!row) throw new Error('The row was not created')
    expect((await readDraft(id, 'es')).items).toMatchObject([{ text: '[es] Open' }])

    // The row is locked and its source changes: the write is refused, the row keeps our
    // earlier translation and the locale is stale, not up to date with the new source.
    await setRows(id, [{ ...row, text: 'Open again', locked: true }])
    await translateAndWait(harness, body)
    expect((await readDraft(id, 'es')).items).toMatchObject([{ text: '[es] Open' }])
    const record = await findRecord(harness, { docId: id, targetLocale: 'es' })
    expect(record?.kept).toEqual([`items.${row.id}.text`])
    expect(
      localeStatus(await status(harness, { collection: 'guarded', id }), 'es'),
    ).toMatchObject({ state: 'done', stale: true, changed: 1, kept: 1 })

    // Unlocked, the row still counts as ours: the next run translates it without
    // `overwriteEdited`.
    await setRows(id, [{ ...row, text: 'Open again', locked: false }])
    await translateAndWait(harness, body)
    expect((await readDraft(id, 'es')).items).toMatchObject([{ text: '[es] Open again' }])
    expect(
      localeStatus(await status(harness, { collection: 'guarded', id }), 'es'),
    ).toMatchObject({ state: 'done', stale: false, changed: 0, kept: 0 })
  })

  // `en` and `fr` hold the same text. A row translated from `en`, then refused while
  // locked during a run from `fr`, keeps its `en` fingerprints while the record now says
  // `fr`: once unlocked, the next run from `fr` must still translate it.
  it('translates again, once unlocked, a refused row whose fingerprints came from another source locale', async () => {
    const id = await createDoc({ title: 'Twin', items: [{ text: 'Same' }] })
    const [row] = (await readDraft(id, 'en')).items as Items
    if (!row) throw new Error('The row was not created')
    const path = `items.${row.id}.text`
    await harness.payload.update({
      collection: 'guarded' as never,
      id,
      locale: 'fr',
      draft: true,
      data: { title: 'Twin', items: [{ ...row, text: 'Same' }] },
    } as never)
    const fromFrench = {
      collection: 'guarded',
      id,
      sourceLocale: 'fr',
      targetLocales: ['es'],
    }

    await translateAndWait(harness, { ...fromFrench, sourceLocale: 'en' })
    expect((await readDraft(id, 'es')).items).toMatchObject([{ text: '[es] Same' }])
    expect(
      (await findRecord(harness, { docId: id, targetLocale: 'es' }))?.fields,
    ).toMatchObject({ [path]: { sourceLocale: 'en' } })

    await setRows(id, [{ ...row, text: 'Same', locked: true }])
    // An output that differs from the one the row holds, so the refusal shows: a refused
    // write of the very same text is indistinguishable from a successful one.
    sent.mockImplementationOnce(prefixedBy('[es, from fr] '))
    await translateAndWait(harness, fromFrench)
    expect((await readDraft(id, 'es')).items).toMatchObject([{ text: '[es] Same' }])
    const refused = await findRecord(harness, { docId: id, targetLocale: 'es' })
    expect(refused).toMatchObject({ status: 'done', sourceLocale: 'fr', kept: [path] })
    expect(refused?.fields?.[path]).toMatchObject({ sourceLocale: 'en' })

    await setRows(id, [{ ...row, text: 'Same', locked: false }])
    sent.mockClear()
    await translateAndWait(harness, fromFrench)

    expect(sentTexts()).toEqual(['Same'])
    const record = await findRecord(harness, { docId: id, targetLocale: 'es' })
    expect(record).toMatchObject({ status: 'done', sourceLocale: 'fr', kept: [] })
    expect(record?.fields?.[path]).toMatchObject({ sourceLocale: 'fr' })
  })

  it('reports a locale the requester cannot read without comparison data', async () => {
    const id = await createDoc({ title: 'Partly visible' })
    await translateAndWait(harness, {
      collection: 'guarded',
      id,
      sourceLocale: 'en',
      targetLocales: ['es'],
    })
    await harness.payload.update({
      collection: 'guarded' as never,
      id,
      locale: 'en',
      draft: true,
      data: { title: 'Partly visible, changed' },
    } as never)
    expect(
      localeStatus(await status(harness, { collection: 'guarded', id }), 'es'),
    ).toMatchObject({ state: 'done', stale: true, changed: 1 })

    // `es` is hidden from this user; `en` is not, so the status is still served.
    const user = await createUser({
      email: 'reader@example.com',
      roles: [await createRole('no-es')],
    })
    const reply = await callEndpoint<StatusResponse>(harness, {
      method: 'get',
      path: '/translator/status',
      user,
      query: { collection: 'guarded', id },
    })

    expect(reply.status).toBe(200)
    expect(localeStatus(reply, 'es')).toMatchObject({
      state: 'done',
      stale: false,
      changed: 0,
      missing: 0,
    })
  })

  it('never sends or writes a field the requester may not read', async () => {
    const id = await createDoc({ title: 'Public', secretNote: 'Top secret' })

    await translateAndWait(harness, {
      collection: 'guarded',
      id,
      sourceLocale: 'en',
      targetLocales: ['es'],
    })

    expect(sentTexts()).toEqual(['Public'])
    const es = await readDraft(id, 'es')
    expect(es.title).toBe('[es] Public')
    expect(es.secretNote).toBeFalsy()
  })

  it('fails with "Access denied" when the requester loses access before the job runs', async () => {
    const id = await createDoc({ title: 'Revoked' })
    const user = await createUser({ email: 'revoked@example.com', canTranslate: true })
    await queueOnly(
      { collection: 'guarded', id, sourceLocale: 'en', targetLocales: ['es'] },
      user,
    )
    await harness.payload.update({
      collection: 'users',
      id: user.id,
      data: { canTranslate: false } as never,
    })

    await runQueueOnce()

    expect(await findRecord(harness, { docId: id, targetLocale: 'es' })).toMatchObject({
      status: 'failed',
      error: 'Access denied',
    })
    expect(sent).not.toHaveBeenCalled()
    expect((await readDraft(id, 'es')).title).toBeFalsy()
  })

  // The `guarded` update rule only sees a viewer when the roles are populated, as Payload
  // binds `req.user` (`auth.depth`); loaded at depth 0 the job would translate anyway.
  it('fails with "Access denied" when the requester becomes a viewer before the job runs', async () => {
    const id = await createDoc({ title: 'Viewer' })
    const user = await createUser({ email: 'viewer@example.com' })
    await queueOnly(
      { collection: 'guarded', id, sourceLocale: 'en', targetLocales: ['es'] },
      user,
    )
    await harness.payload.update({
      collection: 'users',
      id: user.id,
      data: { roles: [await createRole('viewer')] } as never,
    })

    await runQueueOnce()

    expect(await findRecord(harness, { docId: id, targetLocale: 'es' })).toMatchObject({
      status: 'failed',
      error: 'Access denied',
    })
    expect(sent).not.toHaveBeenCalled()
    expect((await readDraft(id, 'es')).title).toBeFalsy()
  })

  it('translates for a requester whose populated roles allow it', async () => {
    const id = await createDoc({ title: 'Writer' })
    const user = await createUser({
      email: 'writer@example.com',
      roles: [await createRole('writer')],
    })
    await queueOnly(
      { collection: 'guarded', id, sourceLocale: 'en', targetLocales: ['es'] },
      user,
    )

    await runQueueOnce()

    expect(await findRecord(harness, { docId: id, targetLocale: 'es' })).toMatchObject({
      status: 'done',
      error: null,
    })
    expect((await readDraft(id, 'es')).title).toBe('[es] Writer')
  })

  it('fails when the requester was deleted before the job runs', async () => {
    const id = await createDoc({ title: 'Orphan' })
    const user = await createUser({ email: 'gone@example.com' })
    await queueOnly(
      { collection: 'guarded', id, sourceLocale: 'en', targetLocales: ['es'] },
      user,
    )
    await harness.payload.delete({ collection: 'users', id: user.id })

    await runQueueOnce()

    expect(await findRecord(harness, { docId: id, targetLocale: 'es' })).toMatchObject({
      status: 'failed',
      error: MISSING_REQUESTER,
    })
    expect(sent).not.toHaveBeenCalled()
  })
})
