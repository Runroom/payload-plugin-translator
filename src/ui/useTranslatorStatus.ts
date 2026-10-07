'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import type { LocaleStatus, StatusResponse } from '../server/status.js'
import type { Target } from './target.js'

const POLL_MS = 2_000
const INITIAL_RETRY_DELAYS_MS = [2_000, 4_000, 8_000]
// Consecutive poll failures after which polling stops and a retry is offered.
const MAX_FAILED_POLLS = 5

class StatusError extends Error {
  constructor(readonly status: number) {
    super(`translator status ${status}`)
  }
}

export const isInFlight = (item: LocaleStatus): boolean =>
  item.state === 'queued' || item.state === 'running'

export const isRunning = (status: StatusResponse | null): boolean =>
  status?.locales.some(isInFlight) ?? false

const requestStatus = async (
  url: string,
  signal?: AbortSignal,
): Promise<StatusResponse> => {
  const response = await fetch(url, { credentials: 'include', signal })
  if (!response.ok) throw new StatusError(response.status)
  return (await response.json()) as StatusResponse
}

const deniesAccess = (error: unknown): boolean =>
  error instanceof StatusError && (error.status === 403 || error.status === 404)

const wait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })

// 403/404 are the access answer (a user without access, a collection without the
// translator) and hide the control without retrying; any other failure is retried with
// backoff and, once the attempts run out, the control stays hidden until a reload.
const loadInitialStatus = async (
  url: string,
  signal: AbortSignal,
): Promise<StatusResponse | null> => {
  for (const delay of [0, ...INITIAL_RETRY_DELAYS_MS]) {
    if (delay > 0) await wait(delay, signal)
    try {
      return await requestStatus(url, signal)
    } catch (error) {
      if (signal.aborted || deniesAccess(error)) return null
    }
  }
  return null
}

const markQueued = (status: StatusResponse, locales: string[]): StatusResponse => ({
  ...status,
  locales: status.locales.map(item =>
    locales.includes(item.locale) ? { ...item, state: 'queued', error: null } : item,
  ),
})

// `seen` are the locales seen queued or translating during this visit, whoever started
// them: when they finish they are the ones that become "ready" and ask to reload their
// form.
const useStatusState = (): {
  status: StatusResponse | null
  seen: string[]
  apply: (next: StatusResponse | null) => void
  queueLocales: (locales: string[]) => void
  resetSeen: () => void
} => {
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [seen, setSeen] = useState<string[]>([])
  const see = useCallback((locales: string[]): void => {
    if (locales.length === 0) return
    setSeen(current =>
      locales.every(code => current.includes(code))
        ? current
        : [...new Set([...current, ...locales])],
    )
  }, [])
  const apply = useCallback(
    (next: StatusResponse | null): void => {
      setStatus(next)
      see(next?.locales.filter(isInFlight).map(item => item.locale) ?? [])
    },
    [see],
  )
  const queueLocales = useCallback(
    (locales: string[]): void => {
      setStatus(current => (current ? markQueued(current, locales) : current))
      see(locales)
    },
    [see],
  )
  const resetSeen = useCallback((): void => setSeen([]), [])
  return { status, seen, apply, queueLocales, resetSeen }
}

// Each request gets a number when it is sent and is only applied if it is later than the
// last one applied: a slow `refresh()` cannot bring back "Translating…" over a newer poll
// that already said "ready".
const useSequence = (): (() => () => boolean) => {
  const issued = useRef(0)
  const applied = useRef(0)
  return useCallback(() => {
    issued.current += 1
    const sequence = issued.current
    return (): boolean => {
      if (sequence <= applied.current) return false
      applied.current = sequence
      return true
    }
  }, [])
}

const increment = (count: number): number => count + 1

// A 403/404 is one more state (`null`: no access); any other failure is transient.
const pollStatus = async (
  url: string,
  signal: AbortSignal,
): Promise<{ status: StatusResponse | null } | 'failed' | 'aborted'> => {
  try {
    return { status: await requestStatus(url, signal) }
  } catch (error) {
    if (signal.aborted) return 'aborted'
    return deniesAccess(error) ? { status: null } : 'failed'
  }
}

// A transient poll failure keeps the last status; `failedPolls` fires the effect again
// even though `status` did not change. 403/404 are the access answer (expired session,
// permission revoked): they hide the control as in the initial load, and that stops the
// polling. After `MAX_FAILED_POLLS` consecutive failures it stops and offers a retry.
const usePolling = ({
  url,
  status,
  apply,
  next,
}: {
  url: string | null
  status: StatusResponse | null
  apply: (status: StatusResponse | null) => void
  next: () => () => boolean
}): { stalled: boolean; resume: () => void } => {
  const [failedPolls, setFailedPolls] = useState(0)
  const previousURL = useRef(url)
  useEffect(() => {
    if (previousURL.current !== url) {
      previousURL.current = url
      setFailedPolls(0)
    }
  }, [url])
  const stalled = failedPolls >= MAX_FAILED_POLLS
  useEffect(() => {
    if (!url || !isRunning(status) || stalled) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      const isLatest = next()
      void pollStatus(url, controller.signal).then(outcome => {
        if (outcome === 'aborted') return
        if (outcome === 'failed') {
          setFailedPolls(increment)
          return
        }
        setFailedPolls(0)
        if (isLatest()) apply(outcome.status)
      })
    }, POLL_MS)
    return (): void => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [url, status, failedPolls, stalled, apply, next])
  const resume = useCallback((): void => setFailedPolls(0), [])
  return { stalled, resume }
}

export const useTranslatorStatus = ({
  apiBase,
  target,
}: {
  apiBase: string
  target: Target | null
}): {
  status: StatusResponse | null
  refresh: () => Promise<void>
  markQueued: (locales: string[]) => void
  seen: string[]
  stalled: boolean
  retry: () => void
} => {
  const { status, seen, apply, queueLocales, resetSeen } = useStatusState()
  const next = useSequence()
  const url = target
    ? `${apiBase}/translator/status?${new URLSearchParams(target)}`
    : null

  const queuedAt = useRef(0)
  // Another document: what was seen running on the previous one says nothing here.
  useEffect(() => {
    resetSeen()
    queuedAt.current = 0
  }, [url, resetSeen])

  // If it fails, polling the queued locales goes on and brings the real status. A response
  // requested before the last `markQueued` predates the queued records and is discarded.
  const refresh = useCallback(async (): Promise<void> => {
    if (!url) return
    const requestedAt = queuedAt.current
    const isLatest = next()
    try {
      const result = await requestStatus(url)
      if (requestedAt === queuedAt.current && isLatest()) apply(result)
    } catch {}
  }, [url, apply, next])

  // The server has already created the queued records when it answers 202, but the
  // previous status still says `none`/`done`: without this step the control would announce
  // a false "ready" and polling would not start.
  const queue = useCallback(
    (locales: string[]): void => {
      queuedAt.current += 1
      queueLocales(locales)
    },
    [queueLocales],
  )

  // When aborted (the URL changed or the component unmounted), the load returns `null`:
  // applying it would hide the control until the new URL's load arrives.
  useEffect(() => {
    if (!url) return
    const controller = new AbortController()
    const isLatest = next()
    loadInitialStatus(url, controller.signal)
      .then(result => {
        if (!controller.signal.aborted && isLatest()) apply(result)
      })
      .catch(() => {})
    return (): void => controller.abort()
  }, [url, apply, next])

  const { stalled, resume } = usePolling({ url, status, apply, next })
  const retry = useCallback((): void => {
    resume()
    void refresh()
  }, [resume, refresh])

  return { status, refresh, markQueued: queue, seen, stalled, retry }
}
