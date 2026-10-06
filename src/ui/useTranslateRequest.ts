'use client'

import { useState } from 'react'

import type { Message } from './messages.js'
import type { TranslateOptionValues } from './options.js'
import type { Target } from './target.js'

const REFUSALS: Record<number, string> = {
  400: 'translator:badRequest',
  403: 'translator:forbidden',
  404: 'translator:notFound',
  409: 'translator:busy',
  503: 'translator:notConfigured',
}

const errorCodeOf = async (response: Response): Promise<unknown> => {
  try {
    return ((await response.json()) as { error?: unknown } | null)?.error
  } catch {
    return undefined
  }
}

// Un 500 `records-failed` no es un fallo al lanzar: el job ya está encolado, pero sin
// registros el estado no puede seguirlo. El resto de 5xx y los fallos de red sí lo son.
const refusalOf = async (response: Response): Promise<Message | null> => {
  if (response.ok) return null
  const key = REFUSALS[response.status]
  if (key) return { key }
  if (response.status === 500 && (await errorCodeOf(response)) === 'records-failed')
    return { key: 'translator:recordsFailed' }
  return { key: 'translator:requestFailed' }
}

const requestTranslation = async ({
  url,
  body,
}: {
  url: string
  body: Record<string, unknown>
}): Promise<Message | null> => {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    return { key: 'translator:requestFailed' }
  }
  return refusalOf(response)
}

export type SendTranslation = (request: {
  targetLocales: string[]
  options: TranslateOptionValues
}) => Promise<void>

// `onLaunched` y `onRefused` dicen al resumen qué lote seguir; `translated` acumula los
// idiomas lanzados en esta visita, que pasan a «lista» al terminar.
export const useTranslateRequest = ({
  apiBase,
  target,
  sourceLocale,
  markQueued,
  refresh,
  onLaunched,
  onRefused,
}: {
  apiBase: string
  target: Target | null
  sourceLocale: string
  markQueued: (locales: string[]) => void
  refresh: () => Promise<void>
  onLaunched: (locales: string[]) => void
  onRefused: () => void
}): {
  submitting: boolean
  translated: string[]
  notice: Message | null
  clearNotice: () => void
  send: SendTranslation
} => {
  const [submitting, setSubmitting] = useState(false)
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
    if (failure) {
      onRefused()
    } else {
      markQueued(targetLocales)
      onLaunched(targetLocales)
      setTranslated(current => [...new Set([...current, ...targetLocales])])
    }
    await refresh()
  }

  return {
    submitting,
    translated,
    notice,
    clearNotice: () => setNotice(null),
    send,
  }
}
