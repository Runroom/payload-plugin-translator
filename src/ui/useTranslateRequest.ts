'use client'

import { useState } from 'react'

import type {
  EntityQuery,
  TranslateRequestBody,
  TranslatorErrorCode,
} from '../shared/api.js'
import { TRANSLATE_PATH } from '../shared/api.js'
import type { Message } from './messages.js'
import type { TranslateOptionValues } from './options.js'

const REFUSALS: Record<number, string> = {
  400: 'translator:badRequest',
  403: 'translator:forbidden',
  404: 'translator:notFound',
  409: 'translator:busy',
  503: 'translator:notConfigured',
}

const errorCodeOf = async (
  response: Response,
): Promise<TranslatorErrorCode | undefined> => {
  try {
    const error = ((await response.json()) as { error?: unknown } | null)?.error
    return typeof error === 'string' ? (error as TranslatorErrorCode) : undefined
  } catch {
    return undefined
  }
}

// A 500 `records-failed` is not a failure to start: the job is already queued, but without
// records the status cannot follow it. Other 5xx responses and network failures are.
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
  body: TranslateRequestBody
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
}) => Promise<boolean>

type Visit = { key: string | null; translated: string[]; notice: Message | null }

// What one document's visit has started and been told. It is keyed by the document: if
// the control is reused for another one without remounting, the previous document's
// locales must not turn "ready" there, nor its notice show.
const useVisit = (
  key: string | null,
): {
  translated: string[]
  notice: Message | null
  setNotice: (notice: Message | null) => void
  addTranslated: (locales: string[]) => void
} => {
  const [visit, setVisit] = useState<Visit>({ key, translated: [], notice: null })
  const current = visit.key === key ? visit : { key, translated: [], notice: null }
  const update = (change: (visit: Visit) => Partial<Visit>): void =>
    setVisit(previous => {
      const base = previous.key === key ? previous : { key, translated: [], notice: null }
      return { ...base, ...change(base) }
    })
  return {
    translated: current.translated,
    notice: current.notice,
    setNotice: notice => update(() => ({ notice })),
    addTranslated: locales =>
      update(base => ({ translated: [...new Set([...base.translated, ...locales])] })),
  }
}

// `onLaunched` and `onRefused` tell the summary which batch to follow; `translated`
// accumulates the locales started during this visit, which become "ready" when they
// finish.
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
  target: EntityQuery | null
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
  const visit = useVisit(target ? JSON.stringify(target) : null)

  const send: SendTranslation = async ({ targetLocales, options }) => {
    if (!target) return false
    setSubmitting(true)
    const failure = await requestTranslation({
      url: `${apiBase}${TRANSLATE_PATH}`,
      body: {
        ...target,
        sourceLocale,
        targetLocales,
        ...options,
      },
    })
    setSubmitting(false)
    visit.setNotice(failure)
    if (failure) {
      onRefused()
    } else {
      markQueued(targetLocales)
      onLaunched(targetLocales)
      visit.addTranslated(targetLocales)
    }
    await refresh()
    return !failure
  }

  return {
    submitting,
    translated: visit.translated,
    notice: visit.notice,
    clearNotice: () => visit.setNotice(null),
    send,
  }
}
