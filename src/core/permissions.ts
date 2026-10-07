import type {
  SanitizedBlocksPermissions,
  SanitizedFieldPermissions,
  SanitizedFieldsPermissions,
} from 'payload'

type Entry = SanitizedFieldPermissions | undefined

const granted = (entry: Entry, operation: 'read' | 'update'): boolean =>
  entry === true || entry?.[operation] === true

const fieldsOf = (entry: Entry): SanitizedFieldsPermissions =>
  entry === true ? true : (entry?.fields ?? {})

const blocksOf = (entry: Entry): SanitizedBlocksPermissions | undefined =>
  entry === true ? true : entry?.blocks

const namesOf = (
  read: SanitizedFieldsPermissions,
  update: SanitizedFieldsPermissions,
): string[] => {
  const base = read === true ? update : read
  if (base === true) return []
  const names = Object.keys(base)
  return update === true || read === true
    ? names
    : names.filter(name => name in (update as Record<string, unknown>))
}

type Block = Exclude<SanitizedBlocksPermissions, true>[string]

const blockFieldsOf = (block: Block): SanitizedFieldsPermissions =>
  block === true ? true : block.fields

const mergeBlock = (
  read: Block | undefined,
  update: Block | undefined,
): Block | undefined => {
  if (read === undefined || update === undefined) return undefined
  if (read === true && update === true) return true
  return { fields: mergeFieldPermissions(blockFieldsOf(read), blockFieldsOf(update)) }
}

const mergeBlocks = (
  read: SanitizedBlocksPermissions | undefined,
  update: SanitizedBlocksPermissions | undefined,
): SanitizedBlocksPermissions | undefined => {
  if (read === undefined || update === undefined) return undefined
  if (read === true && update === true) return true
  const merged: Exclude<SanitizedBlocksPermissions, true> = {}
  for (const slug of Object.keys(read === true ? update : read)) {
    const block = mergeBlock(
      read === true ? true : read[slug],
      update === true ? true : update[slug],
    )
    if (block !== undefined) merged[slug] = block
  }
  return merged
}

const mergeEntry = (read: Entry, update: Entry): Entry => {
  if (read === true && update === true) return true
  if (!granted(read, 'read') || !granted(update, 'update')) return undefined
  const blocks = mergeBlocks(blocksOf(read), blocksOf(update))
  return {
    create: true,
    read: true,
    update: true,
    fields: mergeFieldPermissions(fieldsOf(read), fieldsOf(update)),
    ...(blocks === undefined ? {} : { blocks }),
  }
}

// The source is read in one locale and the target written in another, and the access
// rules of a field may differ between them. A field is translatable when it is readable
// in the source locale and updatable in the target locale, at every nesting level.
export const mergeFieldPermissions = (
  read: SanitizedFieldsPermissions,
  update: SanitizedFieldsPermissions,
): SanitizedFieldsPermissions => {
  if (read === true && update === true) return true
  const merged: Exclude<SanitizedFieldsPermissions, true> = {}
  for (const name of namesOf(read, update)) {
    const entry = mergeEntry(
      read === true ? true : read[name],
      update === true ? true : update[name],
    )
    if (entry !== undefined) merged[name] = entry
  }
  return merged
}
