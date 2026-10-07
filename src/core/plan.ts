import { fingerprintOf } from './fingerprint.js'
import type { TranslatableValue } from './types.js'

// `sourceLocale` is the locale the `source` fingerprint was taken from. It is kept per
// field because one record can hold entries from several runs: a field the requester may
// not touch, or whose write was refused, keeps the entry of an earlier run from another
// locale while the record itself names the locale of the last run.
export type FieldHashes = Record<
  string,
  { source: string; output: string | null; sourceLocale?: string }
>

export type TranslationPlan = {
  translate: TranslatableValue[]
  hashes: FieldHashes
  kept: string[]
  // Target fingerprint of every field in `translate` when it was planned, to notice a
  // field edited while the provider ran.
  targetHashes: Record<string, string | null>
}

type Decision = 'translate' | 'unchanged' | 'kept'

type Locales = { sourceLocale?: string; previousSourceLocale?: string }

// Up to date: the target still holds our output of this very source text, taken from this
// source locale. The same text in another source locale may mean something else, so a
// translation from a different locale is never up to date, however equal the fingerprints
// are. The entry's own locale decides; without one, the record's.
const isUpToDate = ({
  sourceHash,
  targetHash,
  previous,
  locales,
}: {
  sourceHash: string
  targetHash: string | null
  previous: FieldHashes[string] | undefined
  locales: Locales
}): boolean =>
  previous !== undefined &&
  previous.output !== null &&
  targetHash === previous.output &&
  previous.source === sourceHash &&
  isSameSource(
    locales.sourceLocale,
    previous.sourceLocale ?? locales.previousSourceLocale,
  )

const decide = ({
  sourceHash,
  targetHash,
  previous,
  overwriteEdited,
  locales,
}: {
  sourceHash: string
  targetHash: string | null
  previous: FieldHashes[string] | undefined
  overwriteEdited: boolean
  locales: Locales
}): Decision => {
  if (isUpToDate({ sourceHash, targetHash, previous, locales })) return 'unchanged'
  const ours =
    previous !== undefined && previous.output !== null && targetHash === previous.output
  // `overwriteEdited` only affects fields that would be `kept`; up-to-date fields are not
  // translated again.
  if (targetHash === null || ours || overwriteEdited) return 'translate'
  return 'kept'
}

// What every entry a run writes carries: the locale translated from, when known.
const stampOf = (sourceLocale?: string): { sourceLocale?: string } =>
  sourceLocale === undefined ? {} : { sourceLocale }

// Without both locales the source counts as the same.
export const isSameSource = (
  sourceLocale?: string,
  previousSourceLocale?: string,
): boolean =>
  sourceLocale === undefined ||
  previousSourceLocale === undefined ||
  sourceLocale === previousSourceLocale

export const planTranslation = ({
  source,
  target,
  previous = {},
  overwriteEdited,
  sourceLocale,
  previousSourceLocale,
}: {
  source: TranslatableValue[]
  target: TranslatableValue[]
  previous?: FieldHashes
  overwriteEdited: boolean
  // Locale translated from now and the one `previous` was translated from.
  sourceLocale?: string
  previousSourceLocale?: string
}): TranslationPlan => {
  const targetByPath = new Map(target.map(value => [value.path, value]))
  const locales = { sourceLocale, previousSourceLocale }
  const stamp = stampOf(sourceLocale)
  const plan: TranslationPlan = { translate: [], hashes: {}, kept: [], targetHashes: {} }

  for (const value of source) {
    const sourceHash = fingerprintOf(value)
    if (sourceHash === null) {
      // Keep the hashes of an emptied source field. When it is filled again, the old
      // translation must still count as ours, not as edited by hand.
      const kept = previous[value.path]
      if (kept !== undefined) plan.hashes[value.path] = kept
      continue
    }
    const targetValue = targetByPath.get(value.path)
    const targetHash = targetValue ? fingerprintOf(targetValue) : null
    const before = previous[value.path]
    const decision = decide({
      sourceHash,
      targetHash,
      previous: before,
      overwriteEdited,
      locales,
    })
    if (decision === 'translate') {
      plan.translate.push(value)
      plan.targetHashes[value.path] = targetHash
    }
    // An unchanged entry comes from this source locale by definition.
    if (decision === 'unchanged' && before !== undefined)
      plan.hashes[value.path] = { ...before, ...stamp }
    if (decision === 'kept') {
      plan.kept.push(value.path)
      plan.hashes[value.path] = { source: sourceHash, output: null, ...stamp }
    }
  }
  return plan
}

// Fields changed in `sourceLocale` since they were translated from it. An entry taken
// from another locale was not translated from this one, so it counts as changed, as
// `planTranslation` would translate it again; its text there is not read or compared.
export const countChanged = ({
  source,
  hashes,
  sourceLocale,
}: {
  source: TranslatableValue[]
  hashes: FieldHashes
  sourceLocale?: string
}): number =>
  source.filter(value => {
    const hash = fingerprintOf(value)
    if (hash === null) return false
    const entry = hashes[value.path]
    return (
      entry === undefined ||
      entry.source !== hash ||
      !isSameSource(sourceLocale, entry.sourceLocale)
    )
  }).length

// The source fingerprint cannot detect a field someone emptied in the target. Without this
// count, the locale would be reported as up to date with the field blank.
export const countMissing = ({
  source,
  target,
}: {
  source: TranslatableValue[]
  target: TranslatableValue[]
}): number => {
  const targetByPath = new Map(target.map(value => [value.path, value]))
  return source.filter(value => {
    if (fingerprintOf(value) === null) return false
    const targetValue = targetByPath.get(value.path)
    return !targetValue || fingerprintOf(targetValue) === null
  }).length
}
