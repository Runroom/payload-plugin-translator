import type { Payload } from 'payload'
import { JobCancelledError } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import { fingerprint } from '../../../src/core/fingerprint.js'
import { RECORDS_SLUG } from '../../../src/server/records.js'
import { runTranslation } from '../../../src/server/runTranslation.js'
import type { Docs } from './helpers.js'
import {
  fields,
  heldLock,
  input,
  LOCK_TOKEN,
  recordsFor,
  refreshOf,
  settings,
  userOf,
  withLock,
} from './helpers.js'

vi.mock('../../../src/server/docAccess.js', () => ({
  requesterPermissions: vi.fn(async () => true),
}))

type Call = {
  collection?: string
  locale: string
  data?: object
  req?: { transactionID?: string }
}

// An adapter with real transactions: a write made with a transaction id is visible only
// to reads made with it until `commitTransaction`, when it lands in the shared state.
// `onCommit` runs right after that, like a save that waited on the row locks.
const transactionalPayload = ({
  docs,
  onCommit,
}: {
  docs: Docs
  onCommit?: (state: Docs) => void
}): { payload: Payload; records: ReturnType<typeof vi.fn>; log: string[] } => {
  const state: Docs = structuredClone(docs)
  let pending: Docs | null = null
  const log: string[] = []
  const records = vi.fn(async (args: Call) => {
    log.push(`record:${(args.data as { status?: string }).status ?? 'fields'}`)
    return {}
  })
  const viewOf = (call: Call): Docs => (call.req?.transactionID ? pending! : state)
  const db = {
    updateOne: vi.fn(refreshOf(heldLock())),
    deleteMany: vi.fn(),
    beginTransaction: vi.fn(async () => {
      pending = structuredClone(state)
      return 'tx-1'
    }),
    commitTransaction: vi.fn(async () => {
      Object.assign(state, pending)
      pending = null
      log.push('commit')
      onCommit?.(state)
    }),
    rollbackTransaction: vi.fn(async () => {
      pending = null
    }),
  }
  const payload = {
    collections: {
      events: { config: { fields, versions: { drafts: { autosave: false } } } },
    },
    logger: { error: vi.fn(), warn: vi.fn() },
    db,
    config: { blocks: [], localization: { defaultLocale: 'es' } },
    findByID: vi.fn(async (args: Call & { collection?: string; id?: string }) => {
      if (args.collection === 'users') return userOf(args)
      log.push(`read:${args.locale}${args.req?.transactionID ? ':tx' : ''}`)
      return structuredClone(viewOf(args)[args.locale])
    }),
    find: vi.fn(withLock(async () => ({ docs: [] }))),
    create: records,
    update: vi.fn(
      withLock(async (args: Call) => {
        if (args.collection === RECORDS_SLUG) return records(args)
        const view = viewOf(args)
        view[args.locale] = { ...view[args.locale], ...args.data }
        return structuredClone(view[args.locale])
      }),
    ),
  } as unknown as Payload
  return { payload, records, log }
}

const docs: Docs = {
  es: { id: 'e1', title: 'Curso', subtitle: 'Sub' },
  ca: { id: 'e1', title: null, subtitle: null },
}

describe('runTranslation on an adapter with transactions', () => {
  it('retries with corrected fingerprints when a save lands right after the commit', async () => {
    const { payload, records, log } = transactionalPayload({
      docs,
      // Another locale's save, written whole from the snapshot it read, reverts the title.
      onCommit: state => {
        state.ca!.title = null
      },
    })

    const error = await runTranslation({
      isLastAttempt: false,
      payload,
      input,
      settings,
    }).catch((caught: unknown) => caught)

    expect(error).not.toBeInstanceOf(JobCancelledError)
    expect((error as Error).message).toContain('concurrent edit')
    expect(log.slice(log.indexOf('commit'))).toEqual([
      'commit',
      'read:ca',
      'record:fields',
      'record:queued',
    ])
    // The field that survived keeps its fingerprints; the reverted one is dropped, so the
    // retry translates it again instead of keeping its old text as a hand edit.
    const corrected = records.mock.calls.find(
      ([args]) => args.data.fields && args.data.status === undefined,
    )![0]
    expect(corrected.req).toBeUndefined()
    expect(corrected.data).toMatchObject({
      fields: {
        subtitle: { source: fingerprint(['Sub']), output: fingerprint(['[ca] Sub']) },
      },
      lockToken: LOCK_TOKEN,
    })
    expect(Object.keys(corrected.data.fields)).toEqual(['subtitle'])
    expect(recordsFor(records, 'ca').at(-1)).toMatchObject({
      status: 'queued',
      error: expect.stringContaining('it will be retried'),
    })
  })
})
