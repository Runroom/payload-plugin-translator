import type { LocaleStatus, StatusResponse } from '../shared/api.js'
import { isPendingState } from '../shared/api.js'

class StatusError extends Error {
  constructor(readonly status: number) {
    super(`translator status ${status}`)
  }
}

export const isInFlight = (item: LocaleStatus): boolean => isPendingState(item.state)

export const isRunning = (status: StatusResponse | null): boolean =>
  status?.locales.some(isInFlight) ?? false

export const requestStatus = async (
  url: string,
  signal?: AbortSignal,
): Promise<StatusResponse> => {
  const response = await fetch(url, { credentials: 'include', signal })
  if (!response.ok) throw new StatusError(response.status)
  return (await response.json()) as StatusResponse
}

export const deniesAccess = (error: unknown): boolean =>
  error instanceof StatusError && (error.status === 403 || error.status === 404)
