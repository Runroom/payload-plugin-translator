import type { Payload, SanitizedFieldsPermissions } from 'payload'

import type { FieldWrite } from '../core/apply.js'
import { buildUpdateData } from '../core/apply.js'
import { fingerprintOf } from '../core/fingerprint.js'
import type { FieldHashes, TranslationPlan } from '../core/plan.js'
import { planTranslation } from '../core/plan.js'
import { collectTranslatables } from '../core/schema.js'
import { translateUnits } from '../core/translateUnits.js'
import type { TranslatableValue } from '../core/types.js'
import { translatedValue, unitIdsOf } from '../core/units.js'
import type { TranslationProvider } from '../provider/types.js'
import type { Entity, EntityRef } from './entity.js'
import { ConcurrentEditError } from './errors.js'
import type { RecordKey } from './records.js'
import { recordKeyOf, saveRecord } from './records.js'
import type { TranslatorSettings } from './settings.js'

export type TranslationJobInput = EntityRef & {
  sourceLocale: string
  targetLocales: string[]
  overwriteEdited: boolean
  fieldPermissions?: SanitizedFieldsPermissions
}

type PathWrite = FieldWrite & { path: string }

export type LocaleRun = {
  payload: Payload
  provider: TranslationProvider
  settings: TranslatorSettings
  input: TranslationJobInput
  entity: Entity
  sourceLocale: string
  targetLocale: string
}

const translatePlan = async ({
  plan,
  run: { payload, provider, settings, input, sourceLocale, targetLocale },
}: {
  plan: TranslationPlan
  run: LocaleRun
}): Promise<PathWrite[]> => {
  const units = new Map(plan.translate.flatMap(unitIdsOf))
  const withMarks = new Set(
    plan.translate
      .filter(value => value.kind === 'richText')
      .flatMap(value => unitIdsOf(value).map(([id]) => id)),
  )
  const result = await translateUnits({
    provider,
    units,
    sourceLocale,
    targetLocale,
    instructions: settings.instructions({ sourceLocale, targetLocale }),
    withMarks: id => withMarks.has(id),
    // The heartbeat only extends the lock, so a failed save is not worth discarding what
    // was already translated.
    onBatch: async () => {
      try {
        await saveRecord(payload, {
          key: recordKeyOf(input, targetLocale),
          data: { status: 'running' },
        })
      } catch (err) {
        payload.logger.warn({ err, msg: 'Could not save the translation heartbeat' })
      }
    },
  })
  return plan.translate.map(value => ({
    path: value.path,
    segments: value.segments,
    value: translatedValue(value, result),
  }))
}

const translatablesOf = (
  run: LocaleRun,
  doc: Record<string, unknown>,
  { restricted = true }: { restricted?: boolean } = {},
): TranslatableValue[] =>
  collectTranslatables({
    fields: run.entity.fields,
    data: doc,
    blocks: run.payload.config.blocks ?? [],
    permissions: restricted ? run.input.fieldPermissions : true,
  })

// Fields the requester may not touch are left out of the plan but keep their fingerprints;
// otherwise the next request by someone who may touch them would treat their text as a
// hand edit. Paths that no longer exist (a removed row) are still dropped.
const keepHiddenHashes = ({
  run,
  sourceDoc,
  plan,
  previous,
}: {
  run: LocaleRun
  sourceDoc: Record<string, unknown>
  plan: { hashes: FieldHashes }
  previous: FieldHashes
}): void => {
  if (run.input.fieldPermissions === undefined) return
  for (const { path } of translatablesOf(run, sourceDoc, { restricted: false })) {
    const hashes = previous[path]
    if (hashes && !(path in plan.hashes)) plan.hashes[path] = hashes
  }
}

// The `output` fingerprint comes from what Payload saved, not from what was sent. If a
// `beforeChange` hook normalizes the value (a `formatSlug`), a fingerprint of the sent
// value would never match, and the next run would treat the field as edited by hand.
const hashesOf = ({
  plan,
  writes,
  written,
  run,
}: {
  plan: TranslationPlan
  writes: PathWrite[]
  written: Record<string, unknown>
  run: LocaleRun
}): FieldHashes => {
  const saved = translatablesOf(run, written)
  const hashes: FieldHashes = {}
  for (const value of plan.translate) {
    if (!writes.some(write => write.path === value.path)) continue
    const savedValue = saved.find(item => item.path === value.path)
    hashes[value.path] = {
      source: fingerprintOf(value)!,
      output: savedValue ? fingerprintOf(savedValue) : null,
    }
  }
  return hashes
}

// Payload does not merge locales on save. Each save (a version or the document, depending
// on drafts) is written whole from the latest one, so an overlapping save in another
// locale can revert this locale's fields to their previous value.
const verifyWrite = async ({
  run,
  hashes,
  previous,
}: {
  run: LocaleRun
  hashes: FieldHashes
  previous: FieldHashes
}): Promise<void> => {
  const { payload, input, entity, targetLocale } = run
  const saved = await entity.read({ locale: targetLocale, withFallback: false })
  const values = translatablesOf(run, saved)
  // A field only counts as verified if it holds our output. An empty field, or one with
  // other text, was overwritten between the write and this read.
  const verified = Object.entries(hashes).filter(([path, { output }]) => {
    const value = values.find(item => item.path === path)
    return output !== null && (value ? fingerprintOf(value) : null) === output
  })
  if (verified.length === Object.keys(hashes).length) return
  // Save the fingerprints of the fields that were written. Otherwise, on the retry, they
  // would match none of our fingerprints and count as edited by hand.
  await saveVerified({
    payload,
    key: recordKeyOf(input, targetLocale),
    fields: { ...previous, ...Object.fromEntries(verified) },
  })
  throw new ConcurrentEditError(
    `A concurrent edit overwrote the ${targetLocale} translation`,
  )
}

const saveVerified = async ({
  payload,
  key,
  fields,
}: {
  payload: Payload
  key: RecordKey
  fields: FieldHashes
}): Promise<void> => {
  try {
    await saveRecord(payload, { key, data: { fields } })
  } catch (err) {
    payload.logger.error({ err, msg: 'Could not save the verified fingerprints' })
  }
}

// A planned field whose target no longer holds what it held at planning time was edited
// while the provider ran. It is kept like a hand edit found at planning time, whatever
// `overwriteEdited`: that option covers the edits that existed when the editor asked.
const dropEdited = ({
  run,
  plan,
  writes,
  targetDoc,
}: {
  run: LocaleRun
  plan: TranslationPlan
  writes: PathWrite[]
  targetDoc: Record<string, unknown>
}): PathWrite[] => {
  const current = new Map(
    translatablesOf(run, targetDoc).map(value => [value.path, fingerprintOf(value)]),
  )
  return writes.filter(write => {
    if ((current.get(write.path) ?? null) === plan.targetHashes[write.path]) return true
    const source = plan.translate.find(value => value.path === write.path)!
    plan.kept.push(write.path)
    plan.hashes[write.path] = { source: fingerprintOf(source)!, output: null }
    return false
  })
}

// Re-read the target right before writing. The provider calls happen between planning and
// this point, and groups are sent whole, so a stale snapshot would revert non-localized
// data that an import or an editor changed in the meantime. An edit between this read and
// the write can still be lost, but that window is milliseconds, not the provider call.
const writeTranslation = async ({
  run,
  plan,
  writes,
}: {
  run: LocaleRun
  plan: TranslationPlan
  writes: PathWrite[]
}): Promise<{ writes: PathWrite[]; written: Record<string, unknown> | null }> => {
  const { entity, targetLocale } = run
  const targetDoc = await entity.read({ locale: targetLocale, withFallback: false })
  const left = dropEdited({ run, plan, writes, targetDoc })
  if (left.length === 0) return { writes: left, written: null }
  const written = await entity.write({
    locale: targetLocale,
    data: buildUpdateData({ targetDoc, writes: left }),
  })
  return { writes: left, written }
}

export type Outcome = { hashes: FieldHashes; kept: string[]; translated: boolean }

// What the record keeps from the last run: its fingerprints and the locale they were
// translated from.
export type Previous = { fields: FieldHashes; sourceLocale: string }

export const execute = async (run: LocaleRun, previous: Previous): Promise<Outcome> => {
  const { entity, input, sourceLocale, targetLocale } = run
  const [sourceDoc, targetDoc] = await Promise.all([
    entity.read({ locale: sourceLocale, withFallback: true }),
    entity.read({ locale: targetLocale, withFallback: false }),
  ])
  const plan = planTranslation({
    source: translatablesOf(run, sourceDoc),
    target: translatablesOf(run, targetDoc),
    previous: previous.fields,
    overwriteEdited: input.overwriteEdited,
    sourceLocale,
    previousSourceLocale: previous.sourceLocale,
  })
  keepHiddenHashes({ run, sourceDoc, plan, previous: previous.fields })
  if (plan.translate.length === 0) {
    return { hashes: plan.hashes, kept: plan.kept, translated: false }
  }

  const translated = await translatePlan({ plan, run })
  const { writes, written } = await writeTranslation({ run, plan, writes: translated })
  if (written === null) {
    return { hashes: plan.hashes, kept: plan.kept, translated: false }
  }
  const hashes = hashesOf({ plan, writes, written, run })
  await verifyWrite({ run, hashes, previous: previous.fields })
  return { hashes: { ...plan.hashes, ...hashes }, kept: plan.kept, translated: true }
}
