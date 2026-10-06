import type { StatusResponse } from '../server/status.js'

export type Translate = (key: never, vars?: Record<string, unknown>) => string

export type Message = { key: string; vars?: Record<string, unknown> }

// Without a reason, the sentence with `{{error}}` would be left hanging on the colon.
export const failedMessage = (error: string | null): Message =>
  error
    ? { key: 'translator:failed', vars: { error } }
    : { key: 'translator:failedNoReason' }

const resultMessages = ({
  status,
  requested,
  doneKey,
}: {
  status: StatusResponse
  requested: string[]
  doneKey: string
}): Message[] | null => {
  const items = status.locales.filter(item => requested.includes(item.locale))
  if (items.some(item => item.state === 'queued' || item.state === 'running')) return null
  const failed = items.find(item => item.state === 'failed')
  if (failed) return [failedMessage(failed.error)]
  const kept = items.reduce((sum, item) => sum + item.kept, 0)
  return [
    { key: doneKey },
    ...(kept > 0 ? [{ key: 'translator:kept', vars: { count: kept } }] : []),
  ]
}

export const summaryMessages = ({
  status,
  requested,
  notice,
  doneKey,
}: {
  status: StatusResponse
  requested: string[]
  notice: Message | null
  doneKey: string
}): Message[] => {
  if (notice) return [notice]
  if (requested.length === 0) return []
  return (
    resultMessages({ status, requested, doneKey }) ?? [{ key: 'translator:inProgress' }]
  )
}
