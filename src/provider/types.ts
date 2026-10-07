/** What a provider receives for one batch of texts in one locale pair. */
export type TranslateRequest = {
  sourceLocale: string
  targetLocale: string
  /** The project's `instructions` for this locale pair; may be empty. */
  instructions: string
  /**
   * Texts to translate, by opaque key. Values may contain numbered tags (`<1>…</1>`,
   * `<2/>`) and the entities `&lt;` and `&amp;`, all of which must come back unchanged.
   */
  units: Record<string, string>
}

/**
 * A translation backend. `translate` must resolve to an object with exactly the same keys
 * as `request.units`. Throw a `ProviderError` to say whether a retry makes sense.
 */
export type TranslationProvider = {
  translate: (request: TranslateRequest) => Promise<Record<string, string>>
}

/** A provider failure. The job retries it only when `retryable` is true. */
export class ProviderError extends Error {
  override readonly name = 'ProviderError'

  constructor(
    message: string,
    /** Whether another attempt could succeed (a rate limit, a timeout, a 5xx). */
    readonly retryable: boolean,
  ) {
    super(message)
  }
}
