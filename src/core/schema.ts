import type {
  Block,
  Field,
  SanitizedFieldPermissions,
  SanitizedFieldsPermissions,
} from 'payload'
import { fieldAffectsData, tabHasName } from 'payload/shared'

import type { PathSegment, TranslatableKind, TranslatableValue } from './types.js'

type Row = Record<string, unknown>

type WalkContext = {
  blocks: Block[]
  out: TranslatableValue[]
}

type WalkArgs = {
  fields: Field[]
  data: Row | undefined
  segments: PathSegment[]
  context: WalkContext
  permissions: SanitizedFieldsPermissions
}

const entryOf = (
  permissions: SanitizedFieldsPermissions,
  name: string,
): SanitizedFieldPermissions | undefined =>
  permissions === true ? true : permissions[name]

const canTranslate = (entry: SanitizedFieldPermissions | undefined): boolean =>
  entry === true || (entry?.read === true && entry.update === true)

const childrenOf = (
  entry: SanitizedFieldPermissions | undefined,
): SanitizedFieldsPermissions => (entry === true ? true : (entry?.fields ?? {}))

const asRow = (value: unknown): Row | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Row)
    : undefined

const asRows = (value: unknown): Row[] =>
  Array.isArray(value) ? value.filter((row): row is Row => asRow(row) !== undefined) : []

const pathOf = (segments: PathSegment[]): string =>
  segments.map(({ key, rowId }) => (rowId ? `${key}.${rowId}` : key)).join('.')

const isExcluded = (field: Field): boolean =>
  (field.custom as Record<string, unknown> | undefined)?.translator === 'exclude'

const blocksOf = (field: Field & { type: 'blocks' }, configBlocks: Block[]): Block[] => {
  const references = (field.blockReferences ?? []).map(reference =>
    typeof reference === 'string'
      ? configBlocks.find(block => block.slug === reference)
      : reference,
  )
  return [...field.blocks, ...references.filter((block): block is Block => !!block)]
}

const walkRows = ({
  rows,
  key,
  fieldsFor,
  permissionsFor,
  segments,
  context,
  permissions,
}: {
  rows: Row[]
  key: string
  fieldsFor: (row: Row) => Field[] | undefined
  permissionsFor?: (row: Row) => SanitizedFieldsPermissions
  segments: PathSegment[]
  context: WalkContext
  permissions: SanitizedFieldsPermissions
}): void => {
  for (const row of rows) {
    const rowFields = fieldsFor(row)
    if (!rowFields || row.id === undefined || row.id === null) continue
    walk({
      fields: rowFields,
      data: row,
      segments: [...segments, { key, rowId: String(row.id) }],
      context,
      permissions: permissionsFor?.(row) ?? permissions,
    })
  }
}

type VisitArgs = {
  field: Field
  data: Row | undefined
  segments: PathSegment[]
  context: WalkContext
  permissions: SanitizedFieldsPermissions
}

const visitTabs = ({ field, data, segments, context, permissions }: VisitArgs): void => {
  if (field.type !== 'tabs') return
  for (const tab of field.tabs) {
    const named = tabHasName(tab)
    const entry = named ? entryOf(permissions, tab.name) : true
    if (!canTranslate(entry)) continue
    walk({
      fields: tab.fields,
      data: named ? asRow(data?.[tab.name]) : data,
      segments: named ? [...segments, { key: tab.name }] : segments,
      context,
      permissions: named ? childrenOf(entry) : permissions,
    })
  }
}

const visitLayout = ({
  field,
  data,
  segments,
  context,
  permissions,
}: VisitArgs): boolean => {
  if (field.type === 'tabs') {
    visitTabs({ field, data, segments, context, permissions })
    return true
  }
  if (field.type === 'row' || field.type === 'collapsible') {
    walk({ fields: field.fields, data, segments, context, permissions })
    return true
  }
  if (field.type === 'group' && !('name' in field && field.name)) {
    walk({ fields: field.fields, data, segments, context, permissions })
    return true
  }
  return false
}

const visitBlocks = ({
  field,
  data,
  segments,
  context,
  entry,
}: VisitArgs & {
  field: Field & { type: 'blocks' }
  entry: SanitizedFieldPermissions
}): void => {
  const available = blocksOf(field, context.blocks)
  const blockPermissions = entry === true ? true : entry.blocks
  walkRows({
    rows: asRows(data?.[field.name]),
    key: field.name,
    fieldsFor: row => available.find(block => block.slug === row.blockType)?.fields,
    permissionsFor: row => {
      const block =
        blockPermissions === true ? true : blockPermissions?.[String(row.blockType)]
      return block === true ? true : (block?.fields ?? {})
    },
    segments,
    context,
    permissions: childrenOf(entry),
  })
}

const visitArray = ({
  field,
  data,
  segments,
  context,
  entry,
}: VisitArgs & {
  field: Field & { type: 'array' }
  entry: SanitizedFieldPermissions
}): void => {
  walkRows({
    rows: asRows(data?.[field.name]),
    key: field.name,
    fieldsFor: () => field.fields,
    segments,
    context,
    permissions: childrenOf(entry),
  })
}

const visitGroup = ({
  field,
  data,
  segments,
  context,
  entry,
}: VisitArgs & {
  field: Field & { type: 'group'; name: string }
  entry: SanitizedFieldPermissions
}): void => {
  walk({
    fields: field.fields,
    data: asRow(data?.[field.name]),
    segments: [...segments, { key: field.name }],
    context,
    permissions: childrenOf(entry),
  })
}

const visitContainer = ({
  field,
  data,
  segments,
  context,
  permissions,
}: VisitArgs): boolean => {
  if (field.type !== 'group' && field.type !== 'array' && field.type !== 'blocks')
    return false
  if (!('name' in field) || typeof field.name !== 'string') return false
  const entry = entryOf(permissions, field.name)
  if (!entry || !canTranslate(entry)) return true
  if (field.type === 'group') {
    visitGroup({ field, data, segments, context, permissions, entry })
    return true
  }
  if (field.type === 'array') {
    visitArray({ field, data, segments, context, permissions, entry })
    return true
  }
  visitBlocks({ field, data, segments, context, permissions, entry })
  return true
}

const kindOf = (field: Field): TranslatableKind | undefined => {
  if (field.type === 'richText') return 'richText'
  if (field.type !== 'text' && field.type !== 'textarea') return undefined
  return 'hasMany' in field && field.hasMany ? undefined : 'text'
}

const visitLocalized = ({
  field,
  data,
  segments,
  context,
  permissions,
}: VisitArgs): void => {
  if (!fieldAffectsData(field) || !field.localized) return
  if (!canTranslate(entryOf(permissions, field.name))) return
  const kind = kindOf(field)
  if (!kind) return
  const here = [...segments, { key: field.name }]
  context.out.push({
    path: pathOf(here),
    segments: here,
    kind,
    value: data?.[field.name] ?? null,
  })
}

const visitDataField = ({
  field,
  data,
  segments,
  context,
  permissions,
}: VisitArgs): void => {
  if (!fieldAffectsData(field) || isExcluded(field)) return
  if (visitContainer({ field, data, segments, context, permissions })) return
  visitLocalized({ field, data, segments, context, permissions })
}

const walk = ({ fields, data, segments, context, permissions }: WalkArgs): void => {
  for (const field of fields) {
    if (!visitLayout({ field, data, segments, context, permissions })) {
      visitDataField({ field, data, segments, context, permissions })
    }
  }
}

export const collectTranslatables = ({
  fields,
  data,
  blocks = [],
  permissions = true,
}: {
  fields: Field[]
  data: unknown
  blocks?: Block[]
  permissions?: SanitizedFieldsPermissions
}): TranslatableValue[] => {
  const context: WalkContext = { blocks, out: [] }
  walk({ fields, data: asRow(data), segments: [], context, permissions })
  return context.out
}

const CONTAINER_TYPES = new Set(['array', 'blocks', 'group'])

// A block can reference itself through `blockReferences`; each one is walked only once or
// the search never ends.
const childFieldsOf = (
  field: Field,
  configBlocks: Block[],
  visited: Set<Block>,
): Field[] => {
  if (field.type === 'tabs') return field.tabs.flatMap(tab => tab.fields)
  if (field.type === 'blocks') {
    return blocksOf(field, configBlocks).flatMap(block => {
      if (visited.has(block)) return []
      visited.add(block)
      return block.fields
    })
  }
  if ('fields' in field && Array.isArray(field.fields)) return field.fields
  return []
}

const ownContainerName = (field: Field): string[] => {
  if (field.type === 'tabs') {
    return field.tabs.flatMap(tab => (tabHasName(tab) && tab.localized ? [tab.name] : []))
  }
  return CONTAINER_TYPES.has(field.type) &&
    'localized' in field &&
    field.localized &&
    'name' in field
    ? [String(field.name)]
    : []
}

// A localized container stores different rows per locale: no source row corresponds to a
// target row, so fingerprinting by row `id` does not apply.
export const findLocalizedContainers = (
  fields: Field[],
  blocks: Block[] = [],
  visited: Set<Block> = new Set(),
): string[] =>
  fields.flatMap(field => [
    ...ownContainerName(field),
    ...findLocalizedContainers(childFieldsOf(field, blocks, visited), blocks, visited),
  ])
