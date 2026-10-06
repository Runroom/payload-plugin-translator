export const TRANSLATOR_WRITE_CONTEXT = { runroomTranslator: true } as const

export const isTranslatorWrite = (context: unknown): boolean =>
  typeof context === 'object' &&
  context !== null &&
  (context as Record<string, unknown>).runroomTranslator === true
