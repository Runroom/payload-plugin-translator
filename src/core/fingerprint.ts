import { createHash } from 'node:crypto'

import { extractContainers, isLexicalState, structureOf } from './lexical.js'
import type { TranslatableValue } from './types.js'

export const unitsOf = ({ kind, value }: TranslatableValue): string[] => {
  if (kind === 'richText') return isLexicalState(value) ? extractContainers(value) : []
  return typeof value === 'string' && value.trim() !== '' ? [value.trim()] : []
}

export const fingerprint = (units: string[]): string | null =>
  units.length === 0
    ? null
    : createHash('sha256').update(JSON.stringify(units)).digest('hex')

// A richText fingerprint does not come from the raw JSON: the admin editor normalizes it
// when opening it (adds keys, reorders) and that is not a content change. What the
// translation copies from the source without going through the model (formatting, links,
// uploads…) does count: if it changed and the fingerprint did not, the target would stay
// "up to date" with the old version.
export const fingerprintOf = (value: TranslatableValue): string | null => {
  const units = unitsOf(value)
  if (value.kind !== 'richText' || !isLexicalState(value.value)) return fingerprint(units)
  if (units.length === 0) return null
  return fingerprint([...units, JSON.stringify(structureOf(value.value))])
}
