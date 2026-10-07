import { isRecord } from './guards.js'
import { TOKEN } from './marks.js'

export type LexicalNode = {
  type: string
  text?: string
  children?: LexicalNode[]
  [key: string]: unknown
}

export type LexicalState = { root: LexicalNode }

export class MarkError extends Error {
  override readonly name = 'MarkError'
}

// `inlineBlock` is treated as a void inline node. Its content is copied from the source,
// not translated, but without it a `text + block + text` paragraph would not be a container
// and none of its text would be translated.
const INLINE_TYPES = new Set([
  'text',
  'link',
  'autolink',
  'linebreak',
  'tab',
  'inlineBlock',
])
const VOID_TYPES = new Set(['linebreak', 'tab', 'inlineBlock'])

// A literal `<18>` or `</2>` in the text would parse as a mark, so `<` and `&` are sent as
// entities and the prompt asks the model to keep them. Parsing decodes them again, so a
// stray `<` the model returns without forming a mark stays plain text.
const escapeText = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')

const unescapeText = (text: string): string =>
  text.replaceAll('&lt;', '<').replaceAll('&amp;', '&')

export const isLexicalState = (value: unknown): value is LexicalState =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { root?: unknown }).root === 'object' &&
  (value as { root?: unknown }).root !== null

const hasText = (nodes: LexicalNode[]): boolean =>
  nodes.some(node =>
    node.type === 'text' ? (node.text ?? '').trim() !== '' : hasText(node.children ?? []),
  )

// A node that mixes inline and block children is not a container, so its text is not
// translated. Real content does not hit this, because Lexical nests sublists inside their
// own `listitem`.
const isContainer = (node: LexicalNode): boolean =>
  Array.isArray(node.children) &&
  node.children.length > 0 &&
  node.children.every(child => INLINE_TYPES.has(child.type)) &&
  hasText(node.children)

// An empty link has no text mark inside, so `<n></n>` would look like a text leaf.
// Treating it as a void keeps every childless pair a text node.
const isVoidNode = (node: LexicalNode): boolean =>
  VOID_TYPES.has(node.type) || (node.type !== 'text' && !node.children?.length)

const serialize = (nodes: LexicalNode[], marks: LexicalNode[]): string =>
  nodes
    .map(node => {
      const index = marks.push(node)
      if (isVoidNode(node)) return `<${index}/>`
      if (node.type === 'text') {
        return `<${index}>${escapeText(node.text ?? '')}</${index}>`
      }
      return `<${index}>${serialize(node.children ?? [], marks)}</${index}>`
    })
    .join('')

const forEachContainer = (
  node: LexicalNode,
  visit: (container: LexicalNode) => void,
): void => {
  if (isContainer(node)) {
    visit(node)
    return
  }
  for (const child of node.children ?? []) forEachContainer(child, visit)
}

export const extractContainers = (state: LexicalState): string[] => {
  const out: string[] = []
  forEachContainer(state.root, container => {
    out.push(serialize(container.children ?? [], []))
  })
  return out
}

type Summary = Record<string, unknown>

const idOf = (value: unknown): unknown => (isRecord(value) ? value.id : value) ?? null

const MAX_DECODES = 10

// Payload's link `beforeChange` runs `encodeURIComponent` on every url its `validateUrl`
// rejects (`example.com/x`, `http://localhost:3000/x`), even when it is already encoded, so
// each save adds a layer (`%2F` → `%252F`). The fingerprint compares the fully decoded url;
// otherwise a freshly written target would never match when read back.
const canonicalUrl = (url: unknown): unknown => {
  if (typeof url !== 'string') return url ?? null
  let current = url
  for (let i = 0; i < MAX_DECODES; i++) {
    let next: string
    try {
      next = decodeURIComponent(current)
    } catch {
      return current
    }
    if (next === current) return current
    current = next
  }
  return current
}

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!isRecord(value)) return value ?? null
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, sortKeys(value[key])]),
  )
}

// The whole `fields` object is copied to the target, custom link fields included, so all of
// it counts. `url` is decoded and `doc` reduced to its id, so saving or populating the
// relation is not a change.
const linkFields = (fields: Record<string, unknown>): Summary =>
  sortKeys({
    ...fields,
    url: canonicalUrl(fields.url),
    newTab: fields.newTab === true,
    linkType: fields.linkType ?? null,
    doc: isRecord(fields.doc)
      ? { relationTo: fields.doc.relationTo ?? null, value: idOf(fields.doc.value) }
      : null,
  }) as Summary

const listAttributes = (node: LexicalNode): Summary => {
  if (node.type === 'list') {
    return { start: typeof node.start === 'number' ? node.start : 1 }
  }
  if (node.type === 'listitem') return { checked: node.checked === true }
  return {}
}

// The target is a clone of the source with only the text replaced, so every attribute that
// affects rendering comes from the source and must count. Each one is listed explicitly
// with its default, because Lexical writes the defaults when the document is opened
// (`format: ''`, `indent: 0`, `style: ''`). Excluded: `version`; `direction` (Lexical
// recomputes it from the text, so it differs per language); `textFormat`/`textStyle` on
// elements (they follow the selection); text `detail`/`mode` (editing behaviour, not
// rendering); and listitem `value` (Lexical renumbers it from the list `start` and the
// position, which already count).
const formatOf = (node: LexicalNode): Summary =>
  node.type === 'text'
    ? { format: node.format ?? 0, style: node.style ?? '' }
    : { format: node.format ?? '' }

const attributesOf = (node: LexicalNode): Summary => {
  const summary: Summary = { type: node.type, ...formatOf(node), ...listAttributes(node) }
  if (Array.isArray(node.children)) summary.indent = node.indent ?? 0
  if (typeof node.tag === 'string') summary.tag = node.tag
  if (typeof node.listType === 'string') summary.listType = node.listType
  if ((node.type === 'link' || node.type === 'autolink') && isRecord(node.fields)) {
    summary.fields = linkFields(node.fields)
  }
  return summary
}

// The `fields` of a `block`, `inlineBlock` or `upload` are copied from the source, not
// translated, so editing them must make the target stale. Keys are sorted so the admin's
// serialization order does not matter, and the block's `id` is dropped because it is not
// content.
const blockFields = (node: LexicalNode): Summary | null => {
  if (!isRecord(node.fields)) return null
  const { id: _id, ...rest } = node.fields
  return sortKeys(rest) as Summary
}

const summarize = (node: LexicalNode): Summary => {
  const summary = attributesOf(node)
  if (node.children?.length) return { ...summary, children: node.children.map(summarize) }
  if (node.type === 'text') return summary
  // For an empty link, the `fields` summarized by `attributesOf` take precedence.
  return {
    fields: blockFields(node),
    ...summary,
    value: idOf(node.value),
    relationTo: node.relationTo ?? null,
    id: node.id ?? null,
  }
}

export const structureOf = (state: LexicalState): Summary => summarize(state.root)

const TEXT_LEAVES = new Set(['text', 'linebreak', 'tab'])

// Element nodes always have a `children` array. A node without one that is not a text leaf
// (`upload`, `block`, `inlineBlock`, `horizontalrule`…) is content even with no text
// around it. An empty editor (no children, or only empty paragraphs) has none.
const hasNodeContent = (node: LexicalNode): boolean =>
  Array.isArray(node.children)
    ? node.children.some(hasNodeContent)
    : !TEXT_LEAVES.has(node.type)

export const hasNonTextContent = (state: LexicalState): boolean =>
  hasNodeContent(state.root)

type Frame = {
  mark: number | null
  children: LexicalNode[]
  text: string
  pending: string
}

const appendText = (stack: Frame[], marks: LexicalNode[], raw: string): void => {
  if (raw === '') return
  const text = unescapeText(raw)
  const top = stack[stack.length - 1]!
  if (top.mark !== null && marks[top.mark - 1]?.type === 'text') {
    top.text += text
    return
  }
  const previous = top.children[top.children.length - 1]
  if (text.trim() !== '') throw new MarkError('Text outside a mark')
  if (previous?.type === 'text') previous.text = `${previous.text ?? ''}${text}`
  else top.pending += text
}

const openMark = ({ stack, marks, used, index }: TokenArgs): void => {
  const template = marks[index - 1]
  const top = stack[stack.length - 1]!
  if (!template || used.has(index) || isVoidNode(template)) {
    throw new MarkError(`Unexpected mark <${index}>`)
  }
  if (top.mark !== null && marks[top.mark - 1]?.type === 'text') {
    throw new MarkError(`Mark <${index}> inside a text`)
  }
  used.add(index)
  stack.push({ mark: index, children: [], text: '', pending: '' })
}

const closeMark = ({ stack, marks, index }: TokenArgs): void => {
  const frame = stack.pop()
  if (!frame || frame.mark !== index || stack.length === 0) {
    throw new MarkError(`Closing </${index}> without an opening`)
  }
  const template = marks[index - 1]!
  const parent = stack[stack.length - 1]!
  if (template.type === 'text') {
    if (frame.text !== '') {
      parent.children.push({ ...template, text: `${parent.pending}${frame.text}` })
      parent.pending = ''
    }
  } else {
    parent.children.push({ ...template, children: mergeTexts(frame.children) })
  }
}

const voidMark = ({ stack, marks, used, index }: TokenArgs): void => {
  const template = marks[index - 1]
  if (!template || used.has(index) || !isVoidNode(template)) {
    throw new MarkError(`Unexpected mark <${index}/>`)
  }
  const top = stack[stack.length - 1]!
  if (top.mark !== null && marks[top.mark - 1]?.type === 'text') {
    throw new MarkError(`Mark <${index}/> inside a text`)
  }
  used.add(index)
  top.children.push({ ...template })
}

type TokenArgs = {
  stack: Frame[]
  marks: LexicalNode[]
  used: Set<number>
  index: number
}

const sameAttributes = (a: LexicalNode, b: LexicalNode): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  keys.delete('text')
  return [...keys].every(key => JSON.stringify(a[key]) === JSON.stringify(b[key]))
}

// Lexical merges adjacent texts with the same format on save. If the model's reordering
// leaves two such texts side by side and they are not merged here, the first edit of the
// draft changes the JSON and the fingerprint reports the field as edited by hand.
const mergeTexts = (nodes: LexicalNode[]): LexicalNode[] =>
  nodes.reduce<LexicalNode[]>((merged, node) => {
    const previous = merged[merged.length - 1]
    if (
      previous?.type === 'text' &&
      node.type === 'text' &&
      sameAttributes(previous, node)
    ) {
      previous.text = `${previous.text ?? ''}${node.text ?? ''}`
    } else {
      merged.push(node)
    }
    return merged
  }, [])

const parse = (input: string, marks: LexicalNode[]): LexicalNode[] => {
  const stack: Frame[] = [{ mark: null, children: [], text: '', pending: '' }]
  const used = new Set<number>()
  let cursor = 0
  for (const match of input.matchAll(TOKEN)) {
    appendText(stack, marks, input.slice(cursor, match.index))
    cursor = match.index + match[0].length
    const args = { stack, marks, used, index: Number(match[1] ?? match[2] ?? match[3]) }
    if (match[1]) voidMark(args)
    else if (match[2]) openMark(args)
    else closeMark(args)
  }
  appendText(stack, marks, input.slice(cursor))
  if (stack.length !== 1 || used.size !== marks.length) {
    throw new MarkError('Marks are missing or left unclosed')
  }
  return mergeTexts(stack[0]!.children)
}

export const replaceContainers = (
  state: LexicalState,
  translated: string[],
): LexicalState => {
  const clone = structuredClone(state)
  let index = 0
  forEachContainer(clone.root, container => {
    const marks: LexicalNode[] = []
    serialize(container.children ?? [], marks)
    const value = translated[index]
    index += 1
    if (value === undefined) throw new MarkError('A paragraph translation is missing')
    container.children = parse(value, marks)
  })
  if (index !== translated.length) {
    throw new MarkError('There are more translations than paragraphs')
  }
  return clone
}
