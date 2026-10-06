'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import type { LocaleStatus, StatusResponse } from '../server/status.js'
import type { Target } from './target.js'

const POLL_MS = 2_000
const INITIAL_RETRY_DELAYS_MS = [2_000, 4_000, 8_000]

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

// 403/404 son la respuesta de acceso (colaboradores, colección sin traductor) y ocultan
// el control sin reintentar; cualquier otro fallo se reintenta con backoff y, agotados
// los intentos, el control queda oculto hasta recargar.
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

// `seen` son los idiomas vistos en cola o traduciéndose en esta visita, los lance quien
// los lance: al terminar son los que pasan a «lista» y los que piden recargar su
// formulario.
const useStatusState = (): {
  status: StatusResponse | null
  seen: string[]
  apply: (next: StatusResponse | null) => void
  queueLocales: (locales: string[]) => void
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
  return { status, seen, apply, queueLocales }
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
} => {
  const { status, seen, apply, queueLocales } = useStatusState()
  const [failedPolls, setFailedPolls] = useState(0)
  const url = target
    ? `${apiBase}/translator/status?${new URLSearchParams(target)}`
    : null

  const queuedAt = useRef(0)

  // Si falla, el sondeo de los locales en cola sigue y trae el estado real. Una respuesta
  // pedida antes del último `markQueued` es anterior a los registros en cola y se descarta.
  const refresh = useCallback(async (): Promise<void> => {
    if (!url) return
    const requestedAt = queuedAt.current
    try {
      const next = await requestStatus(url)
      if (requestedAt === queuedAt.current) apply(next)
    } catch {}
  }, [url, apply])

  // El servidor ya ha creado los registros en cola al responder 202, pero el status
  // previo aún dice `none`/`done`: sin este paso el control anunciaría un «listo» falso
  // y el sondeo no arrancaría.
  const queue = useCallback(
    (locales: string[]): void => {
      queuedAt.current += 1
      queueLocales(locales)
    },
    [queueLocales],
  )

  useEffect(() => {
    if (!url) return
    const controller = new AbortController()
    loadInitialStatus(url, controller.signal)
      .then(apply)
      .catch(() => {})
    return (): void => controller.abort()
  }, [url, apply])

  // Un fallo pasajero del sondeo conserva el último estado; `failedPolls` vuelve a
  // disparar el efecto aunque `status` no haya cambiado.
  useEffect(() => {
    if (!url || !isRunning(status)) return
    const controller = new AbortController()
    const onFailure = (): void => {
      if (!controller.signal.aborted) setFailedPolls(count => count + 1)
    }
    const timer = setTimeout(() => {
      requestStatus(url, controller.signal).then(apply).catch(onFailure)
    }, POLL_MS)
    return (): void => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [url, status, failedPolls, apply])

  return { status, refresh, markQueued: queue, seen }
}
