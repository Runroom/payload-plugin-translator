import type { FieldWrite } from '../core/apply.js'
import { fingerprintOf } from '../core/fingerprint.js'
import type { FieldHashes, TranslationPlan } from '../core/plan.js'
import { isSameSource } from '../core/plan.js'
import { collectTranslatables } from '../core/schema.js'
import type { TranslatableValue } from '../core/types.js'
import type { LocaleRun } from './localeRun.js'

export type PathWrite = FieldWrite & { path: string }

export const translatablesOf = (
  run: LocaleRun,
  doc: Record<string, unknown>,
  { restricted = true }: { restricted?: boolean } = {},
): TranslatableValue[] =>
  collectTranslatables({
    fields: run.entity.fields,
    data: doc,
    blocks: run.payload.config.blocks ?? [],
    permissions: restricted ? run.permissions : true,
  })

// Fields the requester may not touch are left out of the plan but keep their fingerprints;
// otherwise the next request by someone who may touch them would treat their text as a
// hand edit. Paths that no longer exist (a removed row) are still dropped, and so is
// everything when the source locale changed: the record is stamped with the new source
// locale, and those fingerprints were taken from the old one.
export const keepHiddenHashes = ({
  run,
  sourceDoc,
  plan,
  previous,
  previousSourceLocale,
}: {
  run: LocaleRun
  sourceDoc: Record<string, unknown>
  plan: { hashes: FieldHashes }
  previous: FieldHashes
  previousSourceLocale: string
}): void => {
  if (run.permissions === true) return
  if (!isSameSource(run.sourceLocale, previousSourceLocale)) return
  for (const { path } of translatablesOf(run, sourceDoc, { restricted: false })) {
    const hashes = previous[path]
    if (hashes && !(path in plan.hashes)) plan.hashes[path] = hashes
  }
}

// Payload does not reject a field whose row-level `access.update` denies the write (a
// locked row): it silently keeps the previous value. A field saved with the value it held
// right before the write, and not with what was sent, was refused that way. It is listed
// as kept, so the run does not fail, and its previous fingerprints stay as they were: if
// the row still holds our earlier output, the next run tries again once it is unlocked.
const wasRefused = ({
  value,
  sent,
  saved,
  before,
}: {
  value: TranslatableValue
  sent: PathWrite
  saved: TranslatableValue | undefined
  before: string | null | undefined
}): boolean => {
  const savedHash = saved ? fingerprintOf(saved) : null
  if (savedHash === fingerprintOf({ ...value, value: sent.value })) return false
  return savedHash === (before ?? null)
}

// The `output` fingerprint comes from what Payload saved, not from what was sent. If a
// `beforeChange` hook normalizes the value (a `formatSlug`), a fingerprint of the sent
// value would never match, and the next run would treat the field as edited by hand.
export const hashesOf = ({
  plan,
  writes,
  written,
  before,
  previous,
  run,
}: {
  plan: TranslationPlan
  writes: PathWrite[]
  written: Record<string, unknown>
  before: Map<string, string | null>
  previous: FieldHashes
  run: LocaleRun
}): FieldHashes => {
  const saved = translatablesOf(run, written)
  const hashes: FieldHashes = {}
  for (const value of plan.translate) {
    const sent = writes.find(write => write.path === value.path)
    if (!sent) continue
    const savedValue = saved.find(item => item.path === value.path)
    const source = fingerprintOf(value)!
    if (wasRefused({ value, sent, saved: savedValue, before: before.get(value.path) })) {
      plan.kept.push(value.path)
      plan.hashes[value.path] = previous[value.path] ?? { source, output: null }
      continue
    }
    hashes[value.path] = { source, output: savedValue ? fingerprintOf(savedValue) : null }
  }
  return hashes
}

// A planned field whose target no longer holds what it held at planning time was edited
// while the provider ran. It is kept like a hand edit found at planning time, whatever
// `overwriteEdited`: that option covers the edits that existed when the editor asked.
export const dropEdited = ({
  plan,
  writes,
  current,
}: {
  plan: TranslationPlan
  writes: PathWrite[]
  current: Map<string, string | null>
}): PathWrite[] =>
  writes.filter(write => {
    if ((current.get(write.path) ?? null) === plan.targetHashes[write.path]) return true
    const source = plan.translate.find(value => value.path === write.path)!
    plan.kept.push(write.path)
    plan.hashes[write.path] = { source: fingerprintOf(source)!, output: null }
    return false
  })
