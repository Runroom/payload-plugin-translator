import type { TranslationProvider } from '../provider/types.js'
import { MarkError, unescapeText } from './lexical.js'
import { marksMatch, textMarksOf, TOKEN } from './marks.js'

const MAX_UNITS = 40
const MAX_CHARS = 12_000

type Args = {
  provider: TranslationProvider
  units: Map<string, string>
  sourceLocale: string
  targetLocale: string
  instructions: string
  // Which units carry marks (the `richText` ones), so a literal `<2>` in a `text` field
  // does not fail the mark check. Defaults to every unit.
  withMarks?: (id: string) => boolean
  onBatch?: () => Promise<void>
}

const batchesOf = (entries: [string, string][]): [string, string][][] => {
  const batches: [string, string][][] = []
  let current: [string, string][] = []
  let chars = 0
  for (const entry of entries) {
    const full = current.length >= MAX_UNITS || chars + entry[1].length > MAX_CHARS
    if (full && current.length > 0) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(entry)
    chars += entry[1].length
  }
  if (current.length > 0) batches.push(current)
  return batches
}

const translateBatch = async (
  { provider, sourceLocale, targetLocale, instructions }: Args,
  batch: [string, string][],
): Promise<[string, string][]> => {
  const units = Object.fromEntries(batch.map(([, text], index) => [`u${index}`, text]))
  const reply = await provider.translate({
    sourceLocale,
    targetLocale,
    instructions,
    units,
  })
  return batch.flatMap(([id], index) => {
    const text: unknown = reply[`u${index}`]
    return typeof text === 'string' ? [[id, text]] : []
  })
}

const translateAll = async (
  args: Args,
  entries: [string, string][],
): Promise<Map<string, string>> => {
  const result = new Map<string, string>()
  for (const batch of batchesOf(entries)) {
    for (const [id, text] of await translateBatch(args, batch)) result.set(id, text)
    await args.onBatch?.()
  }
  return result
}

// The text of a marked unit, without its marks: `<1></1>` has valid marks and is not a
// blank string, but writing it would empty the paragraph.
const textOf = (unit: string): string => unescapeText(unit.replaceAll(TOKEN, ''))

// A blank answer for a unit with text would empty the target field. For a plain text unit
// nothing else catches it, since there are no marks to compare.
const isBlankFor = (source: string, text: string, hasMarks: boolean): boolean => {
  const [sourceText, resultText] = hasMarks
    ? [textOf(source), textOf(text)]
    : [source, text]
  return sourceText.trim() !== '' && resultText.trim() === ''
}

// `<1></1><2>mundo</2>` for `<1>Hello </1><2>world</2>` has valid marks and text, but the
// parser drops the empty text node and the source text is lost. A mark that was only
// whitespace may come back empty, and a non-blank one may move.
const emptiesMark = (source: string, text: string): boolean => {
  const expected = textMarksOf(source)
  const actual = textMarksOf(text)
  if (!expected || !actual) return false
  return [...expected].some(
    ([index, sourceText]) =>
      sourceText.trim() !== '' && (actual.get(index) ?? '').trim() === '',
  )
}

const brokenIn = (
  { withMarks = (): boolean => true }: Args,
  units: Map<string, string>,
  result: Map<string, string>,
): [string, string][] =>
  [...units].filter(([id, source]) => {
    const text = result.get(id)
    const hasMarks = withMarks(id)
    return (
      text === undefined ||
      isBlankFor(source, text, hasMarks) ||
      (hasMarks && (!marksMatch(source, text) || emptiesMark(source, text)))
    )
  })

export const translateUnits = async (args: Args): Promise<Map<string, string>> => {
  // Rich text without units (only uploads or blocks) is rebuilt from the source alone.
  if (args.units.size === 0) return new Map()
  const result = await translateAll(args, [...args.units])
  const broken = brokenIn(args, args.units, result)
  if (broken.length === 0) return result

  const retried = await translateAll(args, broken)
  for (const [id, text] of retried) result.set(id, text)
  const stillBroken = brokenIn(args, new Map(broken), result)
  if (stillBroken.length > 0) {
    throw new MarkError(
      `The translation broke the formatting of: ${stillBroken.map(([id]) => id).join(', ')}`,
    )
  }
  return result
}
