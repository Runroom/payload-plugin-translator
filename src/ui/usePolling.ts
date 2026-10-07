'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import type { StatusResponse } from '../shared/api.js'
import { deniesAccess, isRunning, requestStatus } from './statusRequest.js'

const POLL_MS = 2_000
// Consecutive poll failures after which polling stops and a retry is offered.
const MAX_FAILED_POLLS = 5

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
export const usePolling = ({
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
