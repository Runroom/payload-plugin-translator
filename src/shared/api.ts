// The HTTP contract between the server endpoints and the admin UI: neither side redefines it.

export const TRANSLATE_PATH = '/translator/translate'
export const STATUS_PATH = '/translator/status'

// What identifies the edited entity, in the translate body and in the status query string:
// a global by its slug, a document by collection and id.
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
  | 'records-failed'

export type TranslatorErrorBody = {
  error: TranslatorErrorCode
  busy?: string[]
  queued?: string[]
}

export type TranslateQueuedBody = { queued: string[] }

export type LocaleStatus = {
  locale: string
  state: 'none' | 'queued' | 'running' | 'done' | 'failed'
  // Locale it was last translated from; `null` without a record.
  sourceLocale: string | null
  stale: boolean
  changed: number
  missing: number
  error: string | null
  translatedAt: string | null
  kept: number
}

// A translation queued or in progress.
export const isPendingState = (state: LocaleStatus['state']): boolean =>
  state === 'queued' || state === 'running'

export type StatusResponse = {
  enabled: boolean
  writesLive: boolean
  // The document's latest publication: a draft translated before it is already published.
  // Always `null` without drafts.
  lastPublishedAt: string | null
  locales: LocaleStatus[]
}
