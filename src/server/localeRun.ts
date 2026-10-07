import type { Payload, SanitizedFieldsPermissions } from 'payload'

import type { FieldWrite } from '../core/apply.js'
import { buildUpdateData } from '../core/apply.js'
import { fingerprintOf, unitsOf } from '../core/fingerprint.js'
import { extractContainers, isLexicalState, replaceContainers } from '../core/lexical.js'
import type { FieldHashes, TranslationPlan } from '../core/plan.js'
import { planTranslation } from '../core/plan.js'
import { collectTranslatables } from '../core/schema.js'
import type { TranslatableValue } from '../core/types.js'
import { translateUnits } from '../provider/translateUnits.js'
import type { TranslationProvider } from '../provider/types.js'
import type { Entity, EntityRef } from './entity.js'
import type { RecordKey } from './records.js'
import { saveRecord } from './records.js'
import type { TranslatorSettings } from './settings.js'

export type TranslationJobInput = EntityRef & {
  sourceLocale: string
  targetLocales: string[]
  overwriteEdited: boolean
  fieldPermissions?: SanitizedFieldsPermissions
}

const unitIdsOf = (value: TranslatableValue): [string, string][] => {
  if (value.kind === 'text') return [[value.path, unitsOf(value)[0] ?? '']]
  const containers = isLexicalState(value.value) ? extractContainers(value.value) : []
  return containers.map((text, index) => [`${value.path}#${index}`, text])
}

const translatedValue = (
  value: TranslatableValue,
  result: Map<string, string>,
): unknown => {
  if (value.kind === 'text') return result.get(value.path)
  if (!isLexicalState(value.value)) return value.value
  const count = extractContainers(value.value).length
  const texts = Array.from(
    { length: count },
    (_, index) => result.get(`${value.path}#${index}`) ?? '',
  )
  return replaceContainers(value.value, texts)
}

type PathWrite = FieldWrite & { path: string }

export const keyOf = (input: EntityRef, targetLocale: string): RecordKey => ({
  entityType: input.entityType,
  collectionSlug: input.collectionSlug,
  docId: input.docId,
  targetLocale,
})

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
    // The heartbeat only extends the lock's life: losing it does not justify throwing away
    // what was translated.
    onBatch: async () => {
      try {
        await saveRecord(payload, {
          key: keyOf(input, targetLocale),
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

// A field the requester may not touch is left out of the plan, but it still exists: its
// fingerprints stay, or the next request by someone who may touch it would take its text
// for a hand edit. Paths that no longer exist (a removed row) are dropped as before.
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

// The `output` fingerprint comes from what Payload saved, not from what was sent: a
// `beforeChange` hook that normalizes the value (a `formatSlug`) would leave the
// fingerprint never matching, and on the retry the field would become "edited by hand".
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

export class ConcurrentEditError extends Error {
  override readonly name = 'ConcurrentEditError'
}

// Payload does not merge locales on save: each save (a version or the document, depending
// on drafts) is written whole from the latest one, so a save in another locale that
// overlaps ours can return this locale's fields to their previous value.
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
  // A translated field that ended up empty does not count as verified: if what is there is
  // not our text, someone overwrote it between the write and this read.
  const verified = Object.entries(hashes).filter(([path, { output }]) => {
    const value = values.find(item => item.path === path)
    return output !== null && (value ? fingerprintOf(value) : null) === output
  })
  if (verified.length === Object.keys(hashes).length) return
  // Without this, on the retry the fields that did get written would match none of our
  // fingerprints and would become "edited by hand".
  await saveVerified({
    payload,
    key: keyOf(input, targetLocale),
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

// The target is read again right before writing: the provider calls happen between the
// planning and this point, and groups are sent whole, so a stale snapshot would return to
// their previous value the non-localized data that an import or an editor changed in the
// meantime.
const writeTranslation = async ({
  run,
  writes,
}: {
  run: LocaleRun
  writes: FieldWrite[]
}): Promise<Record<string, unknown>> => {
  const { entity, targetLocale } = run
  const targetDoc = await entity.read({ locale: targetLocale, withFallback: false })
  return entity.write({
    locale: targetLocale,
    data: buildUpdateData({ targetDoc, writes }),
  })
}

export type Outcome = { hashes: FieldHashes; kept: string[]; translated: boolean }

export const execute = async (
  run: LocaleRun,
  previous: FieldHashes,
): Promise<Outcome> => {
  const { entity, input, sourceLocale, targetLocale } = run
  const [sourceDoc, targetDoc] = await Promise.all([
    entity.read({ locale: sourceLocale, withFallback: true }),
    entity.read({ locale: targetLocale, withFallback: false }),
  ])
  const plan = planTranslation({
    source: translatablesOf(run, sourceDoc),
    target: translatablesOf(run, targetDoc),
    previous,
    overwriteEdited: input.overwriteEdited,
  })
  keepHiddenHashes({ run, sourceDoc, plan, previous })
  if (plan.translate.length === 0) {
    return { hashes: plan.hashes, kept: plan.kept, translated: false }
  }

  const writes = await translatePlan({ plan, run })
  const written = await writeTranslation({ run, writes })
  const hashes = hashesOf({ plan, writes, written, run })
  await verifyWrite({ run, hashes, previous })
  return { hashes: { ...plan.hashes, ...hashes }, kept: plan.kept, translated: true }
}
