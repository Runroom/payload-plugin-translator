import { describe, expect, it } from 'vitest'

import { fingerprintOf } from '../../src/core/fingerprint.js'
import type { TranslationPlan } from '../../src/core/plan.js'
import type { TranslatableValue } from '../../src/core/types.js'
import { dropEdited, hashesOf, keepHiddenHashes } from '../../src/server/localeHashes.js'
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

const previous = {
  subtitle: { source: 'sub-hash', output: 'sub-output', sourceLocale: 'es' },
}

describe('keepHiddenHashes', () => {
  it('carries the fingerprints of fields the requester may not touch', () => {
    const plan = { hashes: {} }

    keepHiddenHashes({ run: run(), sourceDoc, plan, previous })

    expect(plan.hashes).toEqual(previous)
  })

  // An admin translated `subtitle` from `en`; a user allowed only `title` translates from
  // `es`. The entry keeps saying `en`, so the admin's next run from `es` still knows the
  // subtitle is the translator's and re-translates it instead of keeping it as a hand edit.
  it('carries them over with their own source locale when this run is from another one', () => {
    const plan = { hashes: {} }
    const fromEnglish = {
      subtitle: { source: 'sub-hash', output: 'sub-output', sourceLocale: 'en' },
    }

    keepHiddenHashes({ run: run(), sourceDoc, plan, previous: fromEnglish })

    expect(plan.hashes).toEqual(fromEnglish)
  })

  it('leaves alone a hidden field the plan already decided on', () => {
    const planned = { source: 'new-hash', output: null, sourceLocale: 'es' }
    const plan = { hashes: { subtitle: planned } }

    keepHiddenHashes({ run: run(), sourceDoc, plan, previous })

    expect(plan.hashes.subtitle).toBe(planned)
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

  it('records the source alone, from this locale, for a refused field that had no fingerprints', () => {
    const plan = planOf()

    refused(plan, {})

    expect(plan.hashes.title).toEqual({
      source: fingerprintOf(title),
      output: null,
      sourceLocale: 'es',
    })
  })

  it('stamps a written field with the locale it was translated from', () => {
    const plan = planOf()

    const hashes = hashesOf({
      plan,
      writes: [sent],
      written: { title: '[ca] Curso' },
      before: new Map([['title', held]]),
      previous: {},
      run: run(true),
    })

    expect(hashes.title).toEqual({
      source: fingerprintOf(title),
      output: fingerprintOf(field('title', '[ca] Curso')),
      sourceLocale: 'es',
    })
  })
})

describe('dropEdited', () => {
  it('keeps a field edited while the provider ran, stamped with this run’s locale', () => {
    const title = field('title', 'Curso')
    const plan: TranslationPlan = {
      translate: [title],
      hashes: {},
      kept: [],
      targetHashes: { title: null },
    }

    const left = dropEdited({
      plan,
      writes: [{ path: 'title', segments: title.segments, value: '[ca] Curso' }],
      current: new Map([['title', fingerprintOf(field('title', 'Editat'))]]),
      sourceLocale: 'es',
    })

    expect(left).toEqual([])
    expect(plan.kept).toEqual(['title'])
    expect(plan.hashes.title).toEqual({
      source: fingerprintOf(title),
      output: null,
      sourceLocale: 'es',
    })
  })
})
