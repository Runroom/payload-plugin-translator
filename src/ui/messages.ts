import type { es } from '../i18n/es.js'
import type { StatusResponse } from '../shared/api.js'
import { isPendingState } from '../shared/api.js'

type PluralSuffix = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'

// i18next resolves `key_one`/`key_other` from `key` plus `count`, so the plural forms
// are addressed by their base name.
type WithoutPlural<K extends string> = K extends `${infer Base}_${PluralSuffix}`
  ? Base
  : K

export type TranslatorKey =
  `translator:${WithoutPlural<keyof typeof es.translator & string>}`

// 'general:close' is Payload's own key, not one of ours.
export type Translate = (
  key: TranslatorKey | 'general:close',
  vars?: Record<string, unknown>,
) => string

export type Message = { key: TranslatorKey; vars?: Record<string, unknown> }

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
  doneKey: TranslatorKey
}): Message[] | null => {
  const items = status.locales.filter(item => requested.includes(item.locale))
  if (items.some(item => isPendingState(item.state))) return null
  const failed = items.find(item => item.state === 'failed')
  if (failed) return [failedMessage(failed.error)]
  const kept = items.reduce((sum, item) => sum + item.kept, 0)
  const keptNotice: Message[] =
    kept > 0 ? [{ key: 'translator:kept', vars: { count: kept } }] : []
  return [{ key: doneKey }, ...keptNotice]
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
  doneKey: TranslatorKey
}): Message[] => {
  if (notice) return [notice]
  if (requested.length === 0) return []
  return (
    resultMessages({ status, requested, doneKey }) ?? [{ key: 'translator:inProgress' }]
  )
}
