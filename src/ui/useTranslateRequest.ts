'use client'

import { useState } from 'react'

import type { Message } from './messages.js'
import type { TranslateOptionValues } from './options.js'
import type { Target } from './target.js'

const requestTranslation = async ({
  url,
  body,
}: {
  url: string
  body: Record<string, unknown>
}): Promise<Message | null> => {
  try {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (response.status === 409) return { key: 'translator:busy' }
    if (response.status === 503) return { key: 'translator:notConfigured' }
    return response.ok ? null : { key: 'translator:requestFailed' }
  } catch {
    return { key: 'translator:requestFailed' }
  }
}

export type SendTranslation = (request: {
  targetLocales: string[]
  options: TranslateOptionValues
}) => Promise<void>

// `requested` es la última petición (la que resume la región viva); `translated`
// acumula los idiomas lanzados en esta visita, que pasan a «lista» al terminar.
export const useTranslateRequest = ({
  apiBase,
  target,
  sourceLocale,
  markQueued,
  refresh,
}: {
  apiBase: string
  target: Target | null
  sourceLocale: string
  markQueued: (locales: string[]) => void
  refresh: () => Promise<void>
}): {
  submitting: boolean
  requested: string[]
  translated: string[]
  notice: Message | null
  clearNotice: () => void
  send: SendTranslation
} => {
  const [submitting, setSubmitting] = useState(false)
  const [requested, setRequested] = useState<string[]>([])
  const [translated, setTranslated] = useState<string[]>([])
  const [notice, setNotice] = useState<Message | null>(null)

  const send: SendTranslation = async ({ targetLocales, options }) => {
    setSubmitting(true)
    const failure = await requestTranslation({
      url: `${apiBase}/translator/translate`,
      body: {
        ...target,
        sourceLocale,
        targetLocales,
        ...options,
      },
    })
    setSubmitting(false)
    setNotice(failure)
    if (!failure) {
      markQueued(targetLocales)
      setRequested(targetLocales)
      setTranslated(current => [...new Set([...current, ...targetLocales])])
    }
    await refresh()
  }

  return {
    submitting,
    requested,
    translated,
    notice,
    clearNotice: () => setNotice(null),
    send,
  }
}
