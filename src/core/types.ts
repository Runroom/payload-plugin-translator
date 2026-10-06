export type PathSegment = { key: string; rowId?: string }

export type TranslatableKind = 'text' | 'richText'

export type TranslatableValue = {
  path: string
  segments: PathSegment[]
  kind: TranslatableKind
  value: unknown
}
