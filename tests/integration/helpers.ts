import { rm } from 'node:fs/promises'
import type { Payload, PayloadRequest, TypedUser } from 'payload'
import { createLocalReq, getPayload } from 'payload'
import type { MockInstance } from 'vitest'
import { vi } from 'vitest'

import config, { databaseFile } from '../../dev/payload.config.js'
import { RECORDS_SLUG } from '../../src/index.js'
import type { StatusResponse } from '../../src/index.js'
import type { EntityRef } from '../../src/server/entity.js'
import { LOCKS_SLUG } from '../../src/server/lock.js'
import type { TranslationRecord } from '../../src/server/records.js'

export const QUEUE = 'translations'

type JobsRun = Payload['jobs']['run']

export type Harness = {
  payload: Payload
  user: TypedUser
  // Every `payload.jobs.run` call, including the one `POST /translate` starts without
  // awaiting it.
  runs: MockInstance<JobsRun>
}

export const boot = async (): Promise<Harness> => {
  const payload = await getPayload({ config })
  const user = (await payload.create({
    collection: 'users',
    data: { email: 'editor@example.com', password: 'secret-password' } as never,
  })) as unknown as TypedUser
  const runs = vi.spyOn(payload.jobs, 'run')
  return { payload, user, runs }
}

export const shutdown = async ({ payload }: Harness): Promise<void> => {
  await payload.destroy()
  await Promise.all(
    ['', '-wal', '-shm', '-journal'].map(suffix =>
      rm(`${databaseFile}${suffix}`, { force: true }),
    ),
  )
}

type Call = {
  method: 'get' | 'post'
  path: string
  user?: TypedUser | null
  body?: unknown
  query?: Record<string, string>
}

export type Reply<T = unknown> = { status: number; body: T }

// The endpoints are called through their handlers with a request built by Payload's own
// `createLocalReq`, the same helper the Local API uses, with the `json()` that Payload's
// REST handler would add for a JSON body.
export const callEndpoint = async <T>(
  { payload }: Harness,
  { method, path, user = null, body, query = {} }: Call,
): Promise<Reply<T>> => {
  const endpoint = payload.config.endpoints.find(
    item => item.path === path && item.method === method,
  )
  if (!endpoint) throw new Error(`No ${method} endpoint at ${path}`)
  const search = new URLSearchParams(query).toString()
  const req = await createLocalReq(
    {
      user: user ?? undefined,
      urlSuffix: `/api${path}${search ? `?${search}` : ''}`,
      req: { json: async (): Promise<unknown> => body } as Partial<PayloadRequest>,
    },
    payload,
  )
  const response = await endpoint.handler(req)
  return { status: response.status, body: (await response.json()) as T }
}

export type EntityQuery = { collection: string; id: string } | { global: string }

export const translate = (
  harness: Harness,
  body: EntityQuery & {
    sourceLocale: string
    targetLocales: string[]
    overwriteEdited?: boolean
  },
  user: TypedUser | null = harness.user,
): Promise<Reply> =>
  callEndpoint(harness, { method: 'post', path: '/translator/translate', user, body })

export const status = (
  harness: Harness,
  query: EntityQuery,
): Promise<Reply<StatusResponse>> =>
  callEndpoint<StatusResponse>(harness, {
    method: 'get',
    path: '/translator/status',
    user: harness.user,
    query,
  })

const pendingJobs = async ({ payload }: Harness): Promise<number> =>
  (await payload.count({ collection: 'payload-jobs' as never })).totalDocs

export type Job = {
  id: string | number
  processing: boolean
  hasError?: boolean
  error?: { cancelled?: boolean; message?: string } | null
  input: { lockToken?: string }
}

export const listJobs = async ({ payload }: Harness): Promise<Job[]> =>
  (
    await payload.find({
      collection: 'payload-jobs' as never,
      sort: 'createdAt',
      pagination: false,
      depth: 0,
    })
  ).docs as unknown as Job[]

// Queues the job without running it, so the test decides when (and whether) it runs.
export const queueOnly = async (
  harness: Harness,
  body: Parameters<typeof translate>[1],
  user: TypedUser | null = harness.user,
): Promise<Reply> => {
  harness.runs.mockResolvedValueOnce({ noJobsRemaining: false } as never)
  return translate(harness, body, user)
}

export const runJob = async (harness: Harness, id: string | number): Promise<void> => {
  await harness.payload.jobs.run({ queue: QUEUE, where: { id: { in: [id] } } })
}

// A job that failed for good stays in the table; it is removed so `drainQueue` can tell
// that everything else finished.
export const clearFailedJobs = async ({ payload }: Harness): Promise<void> => {
  await payload.delete({
    collection: 'payload-jobs' as never,
    where: { hasError: { equals: true } },
  })
}

export type Lock = { id: string | number; token: string; updatedAt: string }

export const findLock = async (
  { payload }: Harness,
  ref: EntityRef,
): Promise<Lock | undefined> => {
  const { docs } = await payload.find({
    collection: LOCKS_SLUG as never,
    where: {
      and: [
        { entityType: { equals: ref.entityType } },
        { collectionSlug: { equals: ref.collectionSlug } },
        { docId: { equals: ref.docId } },
      ],
    },
    depth: 0,
  })
  return docs[0] as unknown as Lock | undefined
}

// Payload stamps `updatedAt` on every update, so the heartbeat is aged through the adapter.
export const ageLock = async (
  { payload }: Harness,
  lock: Lock,
  ageMs: number,
): Promise<void> => {
  await payload.db.updateOne({
    collection: LOCKS_SLUG,
    id: lock.id,
    data: { updatedAt: new Date(Date.now() - ageMs).toISOString() },
  } as never)
}

// Waits for the runs `POST /translate` started, then runs the queue until it is empty.
// Payload deletes a job once it completes, so an empty jobs collection means every job
// finished; a failed job stays with its error and fails the check.
export const drainQueue = async (harness: Harness): Promise<void> => {
  await Promise.all(harness.runs.mock.results.map(result => result.value))
  for (let round = 0; round < 3 && (await pendingJobs(harness)) > 0; round++) {
    await harness.payload.jobs.run({ queue: QUEUE })
  }
  const left = await pendingJobs(harness)
  if (left > 0) throw new Error(`${left} translation jobs did not finish`)
}

// Translates and waits for the job: the common case of every scenario.
export const translateAndWait = async (
  harness: Harness,
  body: Parameters<typeof translate>[1],
): Promise<void> => {
  const reply = await translate(harness, body)
  if (reply.status !== 202) {
    throw new Error(`POST /translate answered ${reply.status}: ${JSON.stringify(reply)}`)
  }
  await drainQueue(harness)
}

export const findRecord = async (
  { payload }: Harness,
  { docId, targetLocale }: { docId: string; targetLocale: string },
): Promise<TranslationRecord | undefined> => {
  const { docs } = await payload.find({
    collection: RECORDS_SLUG as never,
    where: {
      and: [{ docId: { equals: docId } }, { targetLocale: { equals: targetLocale } }],
    },
  })
  return docs[0] as unknown as TranslationRecord | undefined
}

export const localeStatus = (
  reply: Reply<StatusResponse>,
  locale: string,
): StatusResponse['locales'][number] | undefined =>
  reply.body.locales.find(item => item.locale === locale)

type TextNode = { type: 'text'; text: string; format: number }

const text = (value: string, format = 0): TextNode & Record<string, unknown> => ({
  type: 'text',
  text: value,
  format,
  detail: 0,
  mode: 'normal',
  style: '',
  version: 1,
})

// A Lexical paragraph with plain, bold and linked text, as the admin editor saves it.
export const richParagraph = (words: {
  plain: string
  bold: string
  link: string
  url: string
}): Record<string, unknown> => ({
  root: {
    type: 'root',
    format: '',
    indent: 0,
    version: 1,
    direction: 'ltr',
    children: [
      {
        type: 'paragraph',
        format: '',
        indent: 0,
        version: 1,
        direction: 'ltr',
        textFormat: 0,
        textStyle: '',
        children: [
          text(words.plain),
          text(words.bold, 1),
          {
            type: 'link',
            format: '',
            indent: 0,
            version: 3,
            direction: 'ltr',
            fields: { url: words.url, newTab: false, linkType: 'custom' },
            children: [text(words.link)],
          },
        ],
      },
    ],
  },
})

export type LexicalChild = {
  type: string
  text?: string
  format?: number
  fields?: { url?: string }
  children?: LexicalChild[]
}

// The inline nodes of the first paragraph of a Lexical value.
export const firstParagraph = (body: unknown): LexicalChild[] =>
  (body as { root: { children: LexicalChild[] } }).root.children[0]?.children ?? []
