import type { TypedUser } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { provider } from '../../dev/payload.config.js'
import { MISSING_REQUESTER } from '../../src/server/runTranslation.js'
import type { Harness } from './helpers.js'
import {
  boot,
  findRecord,
  QUEUE,
  shutdown,
  translate,
  translateAndWait,
} from './helpers.js'

type Items = { id: string; text?: string | null; locked?: boolean }[]

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
