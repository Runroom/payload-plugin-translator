/**
 * The request `context` the translator passes on everything it does to your documents as
 * the requester: the access checks, the reads and the writes. Check it with
 * {@link isTranslatorWrite} rather than reading it directly.
 */
export const TRANSLATOR_WRITE_CONTEXT = { runroomTranslator: true } as const

/**
 * Whether a `context` comes from the translator: in a hook, for example to skip
 * revalidating the public site on a draft write; in a field's `access` (`req.context`), to
 * let the translator fill a localized field people may not edit.
 */
export const isTranslatorWrite = (context: unknown): boolean =>
  typeof context === 'object' &&
  context !== null &&
  (context as Record<string, unknown>).runroomTranslator === true
