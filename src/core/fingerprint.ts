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

// La huella de un richText no sale del JSON tal cual: el editor del admin lo normaliza al
// abrirlo (añade claves, reordena) y eso no es un cambio de contenido. Sí entra lo que la
// traducción copia del origen sin pasar por el modelo (formato, enlaces, uploads…): si
// cambia y la huella no, el destino quedaría «al día» con la versión vieja.
export const fingerprintOf = (value: TranslatableValue): string | null => {
  const units = unitsOf(value)
  if (value.kind !== 'richText' || !isLexicalState(value.value)) return fingerprint(units)
  if (units.length === 0) return null
  return fingerprint([...units, JSON.stringify(structureOf(value.value))])
}
