import { describe, expect, it } from 'vitest'

import { fingerprintOf } from '../../src/core/fingerprint.js'
import type { TranslationPlan } from '../../src/core/plan.js'
import type { TranslatableValue } from '../../src/core/types.js'
import { hashesOf, keepHiddenHashes } from '../../src/server/localeHashes.js'
import type { LocaleRun } from '../../src/server/localeRun.js'

const field = (path: string, value: unknown): TranslatableValue => ({
  path,
  segments: [{ key: path }],
  kind: 'text',
  value,
})

const fields = [
  { name: 'title', type: 'text', localized: true },
  { name: 'subtitle', type: 'text', localized: true },
]

// A run from `es` whose requester may only touch `title`.
const run = (permissions: LocaleRun['permissions'] = { title: true }): LocaleRun =>
  ({
    entity: { fields },
    payload: { config: { blocks: [] } },
    permissions,
    sourceLocale: 'es',
  }) as unknown as LocaleRun

const sourceDoc = { title: 'Curso', subtitle: 'Sub' }

const previous = { subtitle: { source: 'sub-hash', output: 'sub-output' } }

describe('keepHiddenHashes', () => {
  it('carries the fingerprints of fields the requester may not touch', () => {
    const plan = { hashes: {} }

    keepHiddenHashes({
      run: run(),
      sourceDoc,
      plan,
      previous,
      previousSourceLocale: 'es',
    })

    expect(plan.hashes).toEqual(previous)
  })

  it('drops them when the record was translated from another locale', () => {
    const plan = { hashes: {} }

    keepHiddenHashes({
      run: run(),
      sourceDoc,
      plan,
      previous,
      previousSourceLocale: 'en',
    })

    expect(plan.hashes).toEqual({})
  })
})

describe('hashesOf', () => {
  const title = field('title', 'Curso')
  const sent = { path: 'title', segments: title.segments, value: '[ca] Curso' }
  const held = fingerprintOf(field('title', 'Antic'))!

  // Payload kept `Antic`, the value the target held before the write: the write was
  // refused.
  const refused = (
    plan: TranslationPlan,
    previousHashes: Record<string, { source: string; output: string | null }>,
  ): ReturnType<typeof hashesOf> =>
    hashesOf({
      plan,
      writes: [sent],
      written: { title: 'Antic' },
      before: new Map([['title', held]]),
      previous: previousHashes,
      run: run(true),
    })

  const planOf = (): TranslationPlan => ({
    translate: [title],
    hashes: {},
    kept: [],
    targetHashes: {},
  })

  it('keeps the previous fingerprints of a field whose write was refused', () => {
    const plan = planOf()
    const entry = { source: 'old-hash', output: held }

    const hashes = refused(plan, { title: entry })

    expect(hashes).toEqual({})
    expect(plan.kept).toEqual(['title'])
    expect(plan.hashes.title).toBe(entry)
  })

  it('records the source alone for a refused field that had no fingerprints', () => {
    const plan = planOf()

    refused(plan, {})

    expect(plan.hashes.title).toEqual({ source: fingerprintOf(title), output: null })
  })
})
