import { extractContainers, isLexicalState, replaceContainers } from './lexical.js'
import type { TranslatableValue } from './types.js'

// The texts sent to the provider for a value: one unit for a `text` field, and one per
// paragraph (container) for a `richText` field, with its formatting as numbered marks.
export const unitsOf = ({ kind, value }: TranslatableValue): string[] => {
  if (kind === 'richText') return isLexicalState(value) ? extractContainers(value) : []
  return typeof value === 'string' && value.trim() !== '' ? [value.trim()] : []
}

// Unit ids in the provider request: the path for a `text` field, and the path plus the
// paragraph index (`path#0`, `path#1`…) for a `richText` field.
export const unitIdsOf = (value: TranslatableValue): [string, string][] => {
  if (value.kind === 'text') return [[value.path, unitsOf(value)[0] ?? '']]
  return unitsOf(value).map((text, index) => [`${value.path}#${index}`, text])
}

// Rebuilds the value from the translated units, looked up by the ids from `unitIdsOf`.
export const translatedValue = (
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
