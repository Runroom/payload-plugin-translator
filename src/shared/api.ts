// The HTTP contract between the server endpoints and the admin UI.

export const TRANSLATE_PATH = '/translator/translate'
export const STATUS_PATH = '/translator/status'

// Identifies the edited entity in the translate body and in the status query string: a
// global by its slug, a document by collection and id.
export type EntityQuery = { global: string } | { collection: string; id: string }

export type TranslateOptions = { overwriteEdited: boolean }

export type TranslateRequestBody = EntityQuery & {
  sourceLocale: string
  targetLocales: string[]
} & Partial<TranslateOptions>

export type TranslatorErrorCode =
  | 'bad-request'
  | 'forbidden'
  | 'not-found'
  | 'not-configured'
  | 'busy'
  | 'failed'

export type TranslatorErrorBody = {
  error: TranslatorErrorCode
  busy?: string[]
}

export type TranslateQueuedBody = { queued: string[] }

/** The translation state of one target locale, as reported by `GET /status`. */
export type LocaleStatus = {
  locale: string
  /**
   * `failed` also covers a job that stopped updating its record for 15 minutes, for
   * example because the process died.
   */
  state: 'none' | 'queued' | 'running' | 'done' | 'failed'
  /** Locale it was last translated from; `null` without a record. */
  sourceLocale: string | null
  /** `changed > 0 || missing > 0`, only measured when `state` is `done`. */
  stale: boolean
  /** Fields changed in the source since the last translation. */
  changed: number
  /** Fields with text in the source that are empty in this locale. */
  missing: number
  error: string | null
  /** Last time the job actually wrote something. */
  translatedAt: string | null
  /** Texts left untouched because they were edited by hand. */
  kept: number
}

export const isPendingState = (state: LocaleStatus['state']): boolean =>
  state === 'queued' || state === 'running'

/** The body of a successful `GET /api/translator/status`. */
export type StatusResponse = {
  /** `false` when `provider` is `null`; the admin then hides the control. */
  enabled: boolean
  /** `true` for entities without drafts, where a translation goes live at once. */
  writesLive: boolean
  /**
   * Date of the latest published version, used to tell whether a translated draft has been
   * published since. Always `null` without drafts or if never published.
   */
  lastPublishedAt: string | null
  /** One entry per locale of the entity, in config order. */
  locales: LocaleStatus[]
}
