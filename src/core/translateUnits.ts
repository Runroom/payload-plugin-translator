import type { TranslationProvider } from '../provider/types.js'
import { MarkError } from './lexical.js'
import { marksMatch } from './marks.js'

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

// A blank answer for a unit with text would empty the target field. For a plain text unit
// nothing else catches it, since there are no marks to compare.
const isBlankFor = (source: string, text: string): boolean =>
  source.trim() !== '' && text.trim() === ''

const brokenIn = (
  { withMarks = (): boolean => true }: Args,
  units: Map<string, string>,
  result: Map<string, string>,
): [string, string][] =>
  [...units].filter(([id, source]) => {
    const text = result.get(id)
    return (
      text === undefined ||
      isBlankFor(source, text) ||
      (withMarks(id) && !marksMatch(source, text))
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
