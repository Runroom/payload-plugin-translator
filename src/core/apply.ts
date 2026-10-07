import { isRecord } from './guards.js'
import type { PathSegment } from './types.js'

export type FieldWrite = { segments: PathSegment[]; value: unknown }

type Row = Record<string, unknown>

const stepInto = (cursor: Row, segment: PathSegment): Row => {
  const next = cursor[segment.key]
  if (segment.rowId === undefined) {
    if (isRecord(next)) return next
    if (next === null || next === undefined) {
      const created: Row = {}
      cursor[segment.key] = created
      return created
    }
    throw new Error(`Field ${segment.key} is not an object in the target`)
  }
  if (!Array.isArray(next)) {
    throw new Error(`Field ${segment.key} is not an array in the target`)
  }
  const row = next.find(item => isRecord(item) && String(item.id) === segment.rowId)
  if (!isRecord(row)) {
    throw new Error(`Row ${segment.key}.${segment.rowId} no longer exists in the target`)
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
