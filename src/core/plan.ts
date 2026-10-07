import { fingerprintOf } from './fingerprint.js'
import type { TranslatableValue } from './types.js'

export type FieldHashes = Record<string, { source: string; output: string | null }>

export type TranslationPlan = {
  translate: TranslatableValue[]
  hashes: FieldHashes
  kept: string[]
  // Target fingerprint of every field in `translate` when it was planned, to notice a
  // field edited while the provider ran.
  targetHashes: Record<string, string | null>
}

type Decision = 'translate' | 'unchanged' | 'kept'

const decide = ({
  sourceHash,
  targetHash,
  previous,
  overwriteEdited,
  sameSource,
}: {
  sourceHash: string
  targetHash: string | null
  previous: FieldHashes[string] | undefined
  overwriteEdited: boolean
  sameSource: boolean
}): Decision => {
  const ours =
    previous !== undefined && previous.output !== null && targetHash === previous.output
  // The same text in another source locale may mean something else, so a translation
  // from a different locale is never up to date, however equal the fingerprints are.
  if (ours && sameSource && previous.source === sourceHash) return 'unchanged'
  // `overwriteEdited` only affects fields that would be `kept`; up-to-date fields are not
  // translated again.
  if (targetHash === null || ours || overwriteEdited) return 'translate'
  return 'kept'
}

// Without both locales the source counts as the same.
const isSameSource = (sourceLocale?: string, previousSourceLocale?: string): boolean =>
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
  const sameSource = isSameSource(sourceLocale, previousSourceLocale)
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
      sameSource,
    })
    if (decision === 'translate') {
      plan.translate.push(value)
      plan.targetHashes[value.path] = targetHash
    }
    if (decision === 'unchanged' && before !== undefined) plan.hashes[value.path] = before
    if (decision === 'kept') {
      plan.kept.push(value.path)
      plan.hashes[value.path] = { source: sourceHash, output: null }
    }
  }
  return plan
}

export const countChanged = ({
  source,
  hashes,
}: {
  source: TranslatableValue[]
  hashes: FieldHashes
}): number =>
  source.filter(value => {
    const hash = fingerprintOf(value)
    return hash !== null && hashes[value.path]?.source !== hash
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
