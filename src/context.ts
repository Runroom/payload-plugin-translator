/**
 * The request `context` the translation job passes on every write it makes to your
 * documents. Check it with {@link isTranslatorWrite} rather than reading it directly.
 */
export const TRANSLATOR_WRITE_CONTEXT = { runroomTranslator: true } as const

/**
 * Whether a hook's `context` comes from a write made by the translation job, for example to
 * skip revalidating the public site on a draft write.
 */
export const isTranslatorWrite = (context: unknown): boolean =>
  typeof context === 'object' &&
  context !== null &&
  (context as Record<string, unknown>).runroomTranslator === true
