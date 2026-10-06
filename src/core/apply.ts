import type { PathSegment } from './types.js'

export type FieldWrite = { segments: PathSegment[]; value: unknown }

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const stepInto = (cursor: Row, segment: PathSegment): Row => {
  const next = cursor[segment.key]
  if (segment.rowId === undefined) {
    if (isRow(next)) return next
    if (next === null || next === undefined) {
      const created: Row = {}
      cursor[segment.key] = created
      return created
    }
    throw new Error(`El campo ${segment.key} no es un objeto en el destino`)
  }
  if (!Array.isArray(next)) {
    throw new Error(`El campo ${segment.key} no es un array en el destino`)
  }
  const row = next.find(item => isRow(item) && String(item.id) === segment.rowId)
  if (!isRow(row)) {
    throw new Error(`La fila ${segment.key}.${segment.rowId} ya no existe en el destino`)
  }
  return row
}

const setAt = (root: Row, segments: PathSegment[], value: unknown): void => {
  const last = segments[segments.length - 1]
  if (!last) return
  const parent = segments.slice(0, -1).reduce(stepInto, root)
  parent[last.key] = value
}

export const buildUpdateData = ({
  targetDoc,
  writes,
}: {
  targetDoc: Record<string, unknown>
  writes: FieldWrite[]
}): Record<string, unknown> => {
  const data: Row = {}
  for (const { segments, value } of writes) {
    const top = segments[0]?.key
    if (top === undefined) continue
    if (!Object.hasOwn(data, top)) data[top] = structuredClone(targetDoc[top] ?? null)
    setAt(data, segments, value)
  }
  return data
}
