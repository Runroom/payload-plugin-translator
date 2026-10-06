import type { TranslationProvider } from './types.js'

// El prefijo va dentro de la primera marca hoja de texto con contenido: fuera de una
// marca, o dentro de un contenedor, el parser de Lexical lo rechazaría. Sin hoja, el valor
// queda intacto.
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
