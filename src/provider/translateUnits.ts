import { MarkError, marksMatch } from '../core/lexical.js'
import type { TranslationProvider } from './types.js'

const MAX_UNITS = 40
const MAX_CHARS = 12_000

type Args = {
  provider: TranslationProvider
  units: Map<string, string>
  sourceLocale: string
  targetLocale: string
  instructions: string
  // Qué unidades llevan marcas (las de `richText`); un `<2>` literal en un campo `text`
  // no es formato y no puede hacer fallar la comprobación. Por defecto, todas.
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

const brokenIn = (
  { withMarks = (): boolean => true }: Args,
  units: Map<string, string>,
  result: Map<string, string>,
): [string, string][] =>
  [...units].filter(([id, source]) => {
    const text = result.get(id)
    return text === undefined || (withMarks(id) && !marksMatch(source, text))
  })

export const translateUnits = async (args: Args): Promise<Map<string, string>> => {
  const result = await translateAll(args, [...args.units])
  const broken = brokenIn(args, args.units, result)
  if (broken.length === 0) return result

  const retried = await translateAll(args, broken)
  for (const [id, text] of retried) result.set(id, text)
  const stillBroken = brokenIn(args, new Map(broken), result)
  if (stillBroken.length > 0) {
    throw new MarkError(
      `La traducción rompió el formato de: ${stillBroken.map(([id]) => id).join(', ')}`,
    )
  }
  return result
}
