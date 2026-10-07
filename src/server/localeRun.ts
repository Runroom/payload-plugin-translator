import type { Payload, SanitizedFieldsPermissions } from 'payload'

import { buildUpdateData } from '../core/apply.js'
import { fingerprintOf } from '../core/fingerprint.js'
import type { FieldHashes, TranslationPlan } from '../core/plan.js'
import { planTranslation } from '../core/plan.js'
import { translateUnits } from '../core/translateUnits.js'
import { translatedValue, unitIdsOf } from '../core/units.js'
import type { TranslationProvider } from '../provider/types.js'
import type { Entity, EntityRef } from './entity.js'
import { ConcurrentEditError, LockLostError } from './errors.js'
import type { PathWrite } from './localeHashes.js'
import {
  dropEdited,
  hashesOf,
  keepHiddenHashes,
  translatablesOf,
} from './localeHashes.js'
import { refreshLock } from './lock.js'
import type { RecordKey } from './records.js'
import { recordKeyOf, saveRecord } from './records.js'
import type { TranslatorSettings } from './settings.js'
import type { TransactionID } from './transaction.js'
import { inTransaction } from './transaction.js'

/** The user who asked for the translation; the job acts on their behalf. */
export type Requester = { collection: string; id: string }

export type TranslationJobInput = EntityRef & {
  sourceLocale: string
  targetLocales: string[]
  overwriteEdited: boolean
  requester: Requester
  // Token of the document lock `POST /translate` took for this job.
  lockToken: string
}

export type LocaleRun = {
  payload: Payload
  provider: TranslationProvider
  settings: TranslatorSettings
  input: TranslationJobInput
  // Reads and writes as the requester, so Payload applies their access rules.
  entity: Entity
  sourceLocale: string
  targetLocale: string
  // The requester's field permissions for this pair of locales, checked when the job runs.
  permissions: SanitizedFieldsPermissions
}

export const LOCK_LOST = 'Superseded by a newer translation request'

// Extends the document lock, and stops the run when a newer request took it over: from
// then on that request's job owns the document and nothing more may be written here.
const assertLock = async ({ payload, input }: LocaleRun): Promise<void> => {
  if (!(await refreshLock(payload, input, input.lockToken)))
    throw new LockLostError(LOCK_LOST)
}

const translatePlan = async ({
  plan,
  run,
}: {
  plan: TranslationPlan
  run: LocaleRun
}): Promise<PathWrite[]> => {
  const { payload, provider, settings, input, sourceLocale, targetLocale } = run
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
    // The record heartbeat is only for display (`/status`), so a failed save is not worth
    // discarding what was already translated; the lock refresh is what keeps the document.
    onBatch: async () => {
      await assertLock(run)
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

// Payload does not merge locales on save. Each save (a version or the document, depending
// on drafts) is written whole from the latest one, so an overlapping save in another
// locale can revert this locale's fields to their previous value.
const verifyWrite = async ({
  run,
  hashes,
  previous,
  transactionID,
}: {
  run: LocaleRun
  hashes: FieldHashes
  previous: FieldHashes
  transactionID: TransactionID | undefined
}): Promise<void> => {
  if (Object.keys(hashes).length === 0) return
  const { payload, input, entity, targetLocale } = run
  const saved = await entity.read({
    locale: targetLocale,
    withFallback: false,
    transactionID,
  })
  const values = translatablesOf(run, saved)
  // A field only counts as verified if it holds our output. An empty field, or one with
  // other text, was overwritten between the write and this read.
  const verified = Object.entries(hashes).filter(([path, { output }]) => {
    const value = values.find(item => item.path === path)
    return output !== null && (value ? fingerprintOf(value) : null) === output
  })
  if (verified.length === Object.keys(hashes).length) return
  // Save the fingerprints of the fields that were written. Otherwise, on the retry, they
  // would match none of our fingerprints and count as edited by hand. In a real transaction
  // this save is rolled back together with the write, which is right: nothing of ours stays.
  await saveVerified({
    payload,
    key: recordKeyOf(input, targetLocale),
    fields: { ...previous, ...Object.fromEntries(verified) },
    transactionID,
  })
  throw new ConcurrentEditError(
    `A concurrent edit overwrote the ${targetLocale} translation`,
  )
}

const saveVerified = async ({
  payload,
  key,
  fields,
  transactionID,
}: {
  payload: Payload
  key: RecordKey
  fields: FieldHashes
  transactionID: TransactionID | undefined
}): Promise<void> => {
  try {
    await saveRecord(payload, { key, data: { fields }, transactionID })
  } catch (err) {
    payload.logger.error({ err, msg: 'Could not save the verified fingerprints' })
  }
}

type Written = {
  writes: PathWrite[]
  written: Record<string, unknown> | null
  // Target fingerprints right before the write, to notice a field Payload refused to write.
  before: Map<string, string | null>
}

// Re-read the target right before writing. The provider calls happen between planning and
// this point, and groups are sent whole, so a stale snapshot would revert non-localized
// data that an import or an editor changed in the meantime. An edit between this read and
// the write can still be lost, but that window is milliseconds, not the provider call.
const writeTranslation = async ({
  run,
  plan,
  writes,
  transactionID,
}: {
  run: LocaleRun
  plan: TranslationPlan
  writes: PathWrite[]
  transactionID: TransactionID | undefined
}): Promise<Written> => {
  const { entity, targetLocale } = run
  const targetDoc = await entity.read({
    locale: targetLocale,
    withFallback: false,
    transactionID,
  })
  const before = new Map(
    translatablesOf(run, targetDoc).map(value => [value.path, fingerprintOf(value)]),
  )
  const left = dropEdited({ plan, writes, current: before })
  if (left.length === 0) return { writes: left, written: null, before }
  const written = await entity.write({
    locale: targetLocale,
    data: buildUpdateData({ targetDoc, writes: left }),
    transactionID,
  })
  return { writes: left, written, before }
}

export type Outcome = { hashes: FieldHashes; kept: string[]; translated: boolean }

// What the record keeps from the last run: its fingerprints and the locale they were
// translated from.
export type Previous = { fields: FieldHashes; sourceLocale: string }

/** Saves the locale's `done` record, inside the write's transaction when there is one. */
export type SaveOutcome = (
  outcome: Outcome,
  transactionID: TransactionID | undefined,
) => Promise<void>

const unchanged = (plan: TranslationPlan): Outcome => ({
  hashes: plan.hashes,
  kept: plan.kept,
  translated: false,
})

// The write, the re-read that verifies it and the record that keeps its fingerprints
// commit together: a record save that fails must not leave our text in the document
// without the fingerprints that say it is ours, or the retry would keep it as a hand edit.
const commitTranslation = async ({
  run,
  plan,
  translated,
  previous,
  save,
}: {
  run: LocaleRun
  plan: TranslationPlan
  translated: PathWrite[]
  previous: Previous
  save: SaveOutcome
}): Promise<Outcome> =>
  inTransaction(run.payload, async transactionID => {
    const { writes, written, before } = await writeTranslation({
      run,
      plan,
      writes: translated,
      transactionID,
    })
    let outcome = unchanged(plan)
    if (written !== null) {
      const hashes = hashesOf({
        plan,
        writes,
        written,
        before,
        previous: previous.fields,
        run,
      })
      await verifyWrite({ run, hashes, previous: previous.fields, transactionID })
      outcome = {
        hashes: { ...plan.hashes, ...hashes },
        kept: plan.kept,
        translated: Object.keys(hashes).length > 0,
      }
    }
    await save(outcome, transactionID)
    return outcome
  })

export const execute = async (
  run: LocaleRun,
  previous: Previous,
  save: SaveOutcome,
): Promise<Outcome> => {
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
  keepHiddenHashes({
    run,
    sourceDoc,
    plan,
    previous: previous.fields,
    previousSourceLocale: previous.sourceLocale,
  })
  if (plan.translate.length === 0) {
    const outcome = unchanged(plan)
    await save(outcome, undefined)
    return outcome
  }

  const translated = await translatePlan({ plan, run })
  // The provider calls took a while: make sure the lock is still ours before writing.
  await assertLock(run)
  return commitTranslation({ run, plan, translated, previous, save })
}
