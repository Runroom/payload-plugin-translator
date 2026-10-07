import type { TranslationProvider } from './types.js'

// The prefix goes inside the first text leaf mark with content: outside a mark, or inside a
// container, the Lexical parser would reject it. Without a leaf, the value is left
// untouched.
const prefixed = (value: string, prefix: string): string => {
  if (!/<\/?\d+\/?>/.test(value)) return `${prefix}${value}`
  return value.replace(/<(\d+)>(?=[^<]*[^<\s])/, `$&${prefix}`)
}

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
