import { fingerprintOf } from './fingerprint.js'
import type { TranslatableValue } from './types.js'

export type FieldHashes = Record<string, { source: string; output: string | null }>

export type TranslationPlan = {
  translate: TranslatableValue[]
  hashes: FieldHashes
  kept: string[]
}

type Decision = 'translate' | 'unchanged' | 'kept'

const decide = ({
  sourceHash,
  targetHash,
  previous,
  overwriteEdited,
}: {
  sourceHash: string
  targetHash: string | null
  previous: FieldHashes[string] | undefined
  overwriteEdited: boolean
}): Decision => {
  const ours =
    previous !== undefined && previous.output !== null && targetHash === previous.output
  if (ours && previous.source === sourceHash) return 'unchanged'
  // `overwriteEdited` solo rescata lo que sería `kept`: lo que está al día no se repite.
  if (targetHash === null || ours || overwriteEdited) return 'translate'
  return 'kept'
}

export const planTranslation = ({
  source,
  target,
  previous = {},
  overwriteEdited,
}: {
  source: TranslatableValue[]
  target: TranslatableValue[]
  previous?: FieldHashes
  overwriteEdited: boolean
}): TranslationPlan => {
  const targetByPath = new Map(target.map(value => [value.path, value]))
  const plan: TranslationPlan = { translate: [], hashes: {}, kept: [] }

  for (const value of source) {
    const sourceHash = fingerprintOf(value)
    if (sourceHash === null) {
      // Un origen vaciado no borra lo que sabemos del destino: al rellenarlo, la
      // traducción vieja tiene que seguir siendo nuestra y no pasar por editada a mano.
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
    })
    if (decision === 'translate') plan.translate.push(value)
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

// Un campo que alguien vació a mano en el destino no lo delata la huella del origen:
// sin esto, el idioma seguiría «al día» con el campo en blanco.
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
