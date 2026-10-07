import type { TranslateOptions } from '../shared/api.js'
import type { TranslatorKey } from './messages.js'

export type TranslateOptionId = keyof TranslateOptions

export type TranslateOptionValues = TranslateOptions

export type TranslateOptionDefinition = {
  id: TranslateOptionId
  labelKey: TranslatorKey
  hintKey: TranslatorKey
}

// Each value is sent in the `POST /translate` body under its `id`. Adding an option takes a
// field in `TranslateOptions` (shared/api.ts), an entry here, and reading it in `parseBody`
// (server/endpoints.ts).
export const TRANSLATE_OPTIONS: TranslateOptionDefinition[] = [
  {
    id: 'overwriteEdited',
    labelKey: 'translator:overwriteEdited',
    hintKey: 'translator:overwriteEditedHint',
  },
]

export const defaultOptionValues = (): TranslateOptionValues => ({
  overwriteEdited: false,
})
