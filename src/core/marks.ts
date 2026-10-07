export const TOKEN = /<(\d+)\/>|<(\d+)>|<\/(\d+)>/g

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
