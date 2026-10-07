import type { TranslationProvider } from './types.js'

// Marked values get the prefix inside the first leaf mark that has text, since the Lexical
// parser rejects text outside a mark or directly inside a container. A value with no such
// mark is returned unchanged.
const prefixed = (value: string, prefix: string): string => {
  if (!/<\/?\d+\/?>/.test(value)) return `${prefix}${value}`
  return value.replace(/<(\d+)>(?=[^<]*[^<\s])/, `$&${prefix}`)
}

/**
 * A provider for tests and E2E runs without an API key: it prefixes every value with
 * `[<locale>] ` instead of translating it.
 *
 * @param options.delayMs Milliseconds to wait before answering, to simulate a slow
 * provider. Defaults to `0`.
 */
export const fakeProvider = ({
  delayMs = 0,
}: { delayMs?: number } = {}): TranslationProvider => ({
  translate: async ({ targetLocale, units }) => {
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
    return Object.fromEntries(
      Object.entries(units).map(([key, value]) => [
        key,
        prefixed(value, `[${targetLocale}] `),
      ]),
    )
  },
})
