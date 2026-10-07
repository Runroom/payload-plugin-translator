import type { TranslateOptions } from '../shared/api.js'

export type TranslateOptionId = keyof TranslateOptions

export type TranslateOptionValues = TranslateOptions

export type TranslateOptionDefinition = {
  id: TranslateOptionId
  labelKey: string
  hintKey: string
}

// Each value travels in the `POST /translate` body with its `id` as the key: a new option
// is a field in `TranslateOptions` (shared/api.ts), an entry here and reading it in
// `parseBody` (server/endpoints.ts).
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
