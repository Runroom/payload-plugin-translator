export type TranslateRequest = {
  sourceLocale: string
  targetLocale: string
  instructions: string
  units: Record<string, string>
}

export type TranslationProvider = {
  translate: (request: TranslateRequest) => Promise<Record<string, string>>
}

export class ProviderError extends Error {
  override readonly name = 'ProviderError'

  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
  }
}
