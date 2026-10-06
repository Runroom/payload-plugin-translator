export type LexicalNode = {
  type: string
  text?: string
  children?: LexicalNode[]
  [key: string]: unknown
}

export type LexicalState = { root: LexicalNode }

export class MarkError extends Error {}

const INLINE_TYPES = new Set(['text', 'link', 'autolink', 'linebreak', 'tab'])
const VOID_TYPES = new Set(['linebreak', 'tab'])
const TOKEN = /<(\d+)\/>|<(\d+)>|<\/(\d+)>/g

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
// translated. Lexical nests sublists inside their own `listitem`, so real content does
// not hit this.
const isContainer = (node: LexicalNode): boolean =>
  Array.isArray(node.children) &&
  node.children.length > 0 &&
  node.children.every(child => INLINE_TYPES.has(child.type)) &&
  hasText(node.children)

// An empty link has no text mark inside, so `<n></n>` would be taken for a text leaf.
// Marking it as a void keeps the invariant that every childless pair is a text node.
const isVoidNode = (node: LexicalNode): boolean =>
  VOID_TYPES.has(node.type) || (node.type !== 'text' && !node.children?.length)

const serialize = (nodes: LexicalNode[], marks: LexicalNode[]): string =>
  nodes
    .map(node => {
      const index = marks.push(node)
      if (isVoidNode(node)) return `<${index}/>`
      if (node.type === 'text') return `<${index}>${node.text ?? ''}</${index}>`
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const idOf = (value: unknown): unknown => (isRecord(value) ? value.id : value) ?? null

const MAX_DECODES = 10

// El `beforeChange` del link de Payload pasa por `encodeURIComponent` cada url que su
// `validateUrl` rechaza (`example.com/x`, `http://localhost:3000/x`), también si ya
// venía codificada: cada guardado añade una capa (`%2F` → `%252F`). La huella compara la
// url sin capas; si no, el destino recién escrito no coincidiría nunca al releerlo.
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

const linkFields = (fields: Record<string, unknown>): Summary => ({
  url: canonicalUrl(fields.url),
  newTab: fields.newTab === true,
  linkType: fields.linkType ?? null,
  doc: isRecord(fields.doc)
    ? { relationTo: fields.doc.relationTo ?? null, value: idOf(fields.doc.value) }
    : null,
})

// Solo claves elegidas una a una: las que Lexical añade o reescribe al abrir el documento
// (`version`, `direction`, `indent`, `style`, `detail`, `mode`…) no pueden entrar.
const attributesOf = (node: LexicalNode): Summary => {
  const summary: Summary = { type: node.type }
  if (node.type === 'text') summary.format = node.format ?? 0
  if (typeof node.tag === 'string') summary.tag = node.tag
  if (typeof node.listType === 'string') summary.listType = node.listType
  if ((node.type === 'link' || node.type === 'autolink') && isRecord(node.fields)) {
    summary.fields = linkFields(node.fields)
  }
  return summary
}

const summarize = (node: LexicalNode): Summary => {
  const summary = attributesOf(node)
  if (node.children?.length) return { ...summary, children: node.children.map(summarize) }
  if (node.type === 'text') return summary
  return {
    ...summary,
    value: idOf(node.value),
    relationTo: node.relationTo ?? null,
    id: node.id ?? null,
  }
}

export const structureOf = (state: LexicalState): Summary => summarize(state.root)

type Frame = {
  mark: number | null
  children: LexicalNode[]
  text: string
  pending: string
}

const appendText = (stack: Frame[], marks: LexicalNode[], text: string): void => {
  if (text === '') return
  const top = stack[stack.length - 1]!
  if (top.mark !== null && marks[top.mark - 1]?.type === 'text') {
    top.text += text
    return
  }
  const previous = top.children[top.children.length - 1]
  if (text.trim() !== '') throw new MarkError('Texto fuera de una marca')
  if (previous?.type === 'text') previous.text = `${previous.text ?? ''}${text}`
  else top.pending += text
}

const openMark = ({ stack, marks, used, index }: TokenArgs): void => {
  const template = marks[index - 1]
  const top = stack[stack.length - 1]!
  if (!template || used.has(index) || isVoidNode(template)) {
    throw new MarkError(`Marca <${index}> inesperada`)
  }
  if (top.mark !== null && marks[top.mark - 1]?.type === 'text') {
    throw new MarkError(`Marca <${index}> dentro de un texto`)
  }
  used.add(index)
  stack.push({ mark: index, children: [], text: '', pending: '' })
}

const closeMark = ({ stack, marks, index }: TokenArgs): void => {
  const frame = stack.pop()
  if (!frame || frame.mark !== index || stack.length === 0) {
    throw new MarkError(`Cierre </${index}> sin apertura`)
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
    throw new MarkError(`Marca <${index}/> inesperada`)
  }
  const top = stack[stack.length - 1]!
  if (top.mark !== null && marks[top.mark - 1]?.type === 'text') {
    throw new MarkError(`Marca <${index}/> dentro de un texto`)
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

// Lexical fusiona al guardar los textos contiguos con el mismo formato; si el modelo los
// junta al reordenar y no se fusionan aquí, la primera edición del borrador cambia el JSON
// y la huella lo daría por editado a mano.
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
    throw new MarkError('Faltan marcas o hay marcas sin cerrar')
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
    if (value === undefined) throw new MarkError('Falta la traducción de un párrafo')
    container.children = parse(value, marks)
  })
  if (index !== translated.length) {
    throw new MarkError('Hay más traducciones que párrafos')
  }
  return clone
}

type MarkShape = {
  pairs: Set<number>
  voids: Set<number>
  texts: Set<number>
  parents: Map<number, number | null>
}

type OpenMark = { index: number; hasChild: boolean; hasText: boolean }

const declare = (
  shape: MarkShape,
  isVoid: boolean,
  index: number,
  parent: number | null,
): boolean => {
  const [set, other] = isVoid ? [shape.voids, shape.pairs] : [shape.pairs, shape.voids]
  if (set.has(index) || other.has(index)) return false
  set.add(index)
  shape.parents.set(index, parent)
  return true
}

const closeShape = (shape: MarkShape, open: OpenMark[], index: number): boolean => {
  const top = open.pop()
  if (!top || top.index !== index) return false
  if (top.hasChild && top.hasText) return false
  if (!top.hasChild) shape.texts.add(index)
  return true
}

const consumeToken = (
  shape: MarkShape,
  open: OpenMark[],
  match: RegExpMatchArray,
): boolean => {
  const index = Number(match[1] ?? match[2] ?? match[3])
  if (match[3]) return closeShape(shape, open, index)
  const parent = open[open.length - 1]
  const isVoid = Boolean(match[1])
  if (!declare(shape, isVoid, index, parent?.index ?? null)) return false
  if (parent) parent.hasChild = true
  if (!isVoid) open.push({ index, hasChild: false, hasText: false })
  return true
}

const isClosed = (shape: MarkShape, open: OpenMark[], tail: string): boolean => {
  const hasMarks = shape.pairs.size > 0 || shape.voids.size > 0
  return open.length === 0 && !(hasMarks && tail.trim() !== '')
}

const shapeOf = (input: string): MarkShape | null => {
  const shape: MarkShape = {
    pairs: new Set(),
    voids: new Set(),
    texts: new Set(),
    parents: new Map(),
  }
  const open: OpenMark[] = []
  let cursor = 0
  for (const match of input.matchAll(TOKEN)) {
    const between = input.slice(cursor, match.index)
    cursor = match.index + match[0].length
    if (between.trim() !== '') {
      const top = open[open.length - 1]
      if (!top) return null
      top.hasText = true
    }
    if (!consumeToken(shape, open, match)) return null
  }
  return isClosed(shape, open, input.slice(cursor)) ? shape : null
}

const sameSet = (a: Set<number>, b: Set<number>): boolean =>
  a.size === b.size && [...a].every(value => b.has(value))

const sameParents = (a: MarkShape, b: MarkShape): boolean =>
  [...a.parents].every(([index, parent]) => b.parents.get(index) === parent)

export const marksMatch = (source: string, translated: string): boolean => {
  const expected = shapeOf(source)
  const actual = shapeOf(translated)
  if (!expected || !actual) return false
  return (
    sameSet(expected.pairs, actual.pairs) &&
    sameSet(expected.voids, actual.voids) &&
    sameSet(expected.texts, actual.texts) &&
    sameParents(expected, actual)
  )
}
