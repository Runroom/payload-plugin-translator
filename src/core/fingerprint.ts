import { createHash } from 'node:crypto'

import { hasNonTextContent, isLexicalState, structureOf } from './lexical.js'
import type { TranslatableValue } from './types.js'
import { unitsOf } from './units.js'

export const fingerprint = (units: string[]): string | null =>
  units.length === 0
    ? null
    : createHash('sha256').update(JSON.stringify(units)).digest('hex')

// A richText fingerprint is not taken from the raw JSON, because the admin editor
// normalizes the state when it opens it (adding keys, reordering them) without changing the
// content. What the translation copies from the source without the model (formatting,
// links, uploads…) does count: otherwise a change there would leave the target reported as
// up to date with the old version. A value with only uploads, blocks or rules has no units
// but still has content to copy, so its fingerprint comes from the structure alone.
export const fingerprintOf = (value: TranslatableValue): string | null => {
  const units = unitsOf(value)
  if (value.kind !== 'richText' || !isLexicalState(value.value)) return fingerprint(units)
  if (units.length === 0 && !hasNonTextContent(value.value)) return null
  return fingerprint([...units, JSON.stringify(structureOf(value.value))])
}
