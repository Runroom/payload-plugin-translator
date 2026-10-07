export type TranslateOptionId = 'overwriteEdited'

export type TranslateOptionValues = Record<TranslateOptionId, boolean>

export type TranslateOptionDefinition = {
  id: TranslateOptionId
  labelKey: string
  hintKey: string
}

// Each value travels in the `POST /translate` body with its `id` as the key: a new option
// is an entry here plus reading it in `parseBody` (server/endpoints.ts).
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
