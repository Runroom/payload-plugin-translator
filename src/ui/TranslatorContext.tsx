'use client'

import type { ReactElement, ReactNode } from 'react'
import { createContext, useContext } from 'react'

import type { LocaleStatus } from '../shared/api.js'
import type { LocaleLink } from './localeLink.js'
import type { Translate } from './messages.js'

type TranslatorContextValue = {
  t: Translate
  language: string
  labelOf: (code: string) => string
  sourceLabelOf: (item: LocaleStatus) => string
  linkOf: (locale: string) => LocaleLink | null
}

const TranslatorContext = createContext<TranslatorContextValue | null>(null)

export const TranslatorProvider = ({
  value,
  children,
}: {
  value: TranslatorContextValue
  children: ReactNode
}): ReactElement => (
  <TranslatorContext.Provider value={value}>{children}</TranslatorContext.Provider>
)

// What every component of the control reads instead of receiving it prop by prop.
export const useTranslator = (): TranslatorContextValue => {
  const value = useContext(TranslatorContext)
  if (!value) throw new Error('useTranslator must be used inside a TranslatorProvider')
  return value
}
