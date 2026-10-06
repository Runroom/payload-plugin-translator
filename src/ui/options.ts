export type TranslateOptionId = 'overwriteEdited'

export type TranslateOptionValues = Record<TranslateOptionId, boolean>

export type TranslateOptionDefinition = {
  id: TranslateOptionId
  labelKey: string
  hintKey: string
}

// Cada valor viaja en el cuerpo del `POST /translate` con su `id` como clave: una opción
// nueva es una entrada aquí más su lectura en `parseBody` (server/endpoints.ts).
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
