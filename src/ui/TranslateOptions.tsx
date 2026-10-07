'use client'

import type { ReactElement } from 'react'
import { useId } from 'react'

import { useTranslator } from './TranslatorContext.js'
import type {
  TranslateOptionDefinition,
  TranslateOptionId,
  TranslateOptionValues,
} from './options.js'

export const TranslateOptions = ({
  definitions,
  values,
  onChange,
}: {
  definitions: TranslateOptionDefinition[]
  values: TranslateOptionValues
  onChange: (id: TranslateOptionId, value: boolean) => void
}): ReactElement => {
  const { t } = useTranslator()
  const baseId = useId()
  return (
    <fieldset className="rr-translator__section">
      <legend className="rr-translator__section-title">{t('translator:options')}</legend>
      {definitions.map(option => {
        const inputId = `${baseId}-${option.id}`
        const hintId = `${inputId}-hint`
        return (
          <div key={option.id} className="rr-translator__option">
            <input
              id={inputId}
              type="checkbox"
              className="rr-translator__checkbox"
              checked={values[option.id]}
              aria-describedby={hintId}
              onChange={event => onChange(option.id, event.target.checked)}
            />
            <label htmlFor={inputId} className="rr-translator__option-label">
              {t(option.labelKey)}
            </label>
            <p id={hintId} className="rr-translator__hint">
              {t(option.hintKey)}
            </p>
          </div>
        )
      })}
    </fieldset>
  )
}
