'use client'

import { useCallback, useState } from 'react'

import type { StatusResponse } from '../shared/api.js'
import { isInFlight } from './useTranslatorStatus.js'

// The batch the live region summarizes: the one started from this control (`own`) or the
// last one seen in progress, whoever started it.
export type SummaryBatch = { locales: string[]; own: boolean }

const EMPTY: SummaryBatch = { locales: [], own: false }

// The followed batch does not change while it is in progress, since the server refuses to
// start another one on the same document. Once it finishes, the next batch seen in progress
// is followed instead, even if the previous one was our own.
const adoptBatch = (batch: SummaryBatch, status: StatusResponse | null): SummaryBatch => {
  const inFlight = status?.locales.filter(isInFlight).map(item => item.locale) ?? []
  if (inFlight.every(locale => batch.locales.includes(locale))) return batch
  const ongoing = status?.locales.some(
    item => batch.locales.includes(item.locale) && isInFlight(item),
  )
  return ongoing ? batch : { locales: inFlight, own: false }
}

export const useSummaryBatch = (
  status: StatusResponse | null,
): {
  batch: SummaryBatch
  launch: (locales: string[]) => void
  reset: () => void
} => {
  const [batch, setBatch] = useState(EMPTY)
  // Adopt the new batch during render, not in an effect, because an intermediate render
  // with the previous batch would put its result back into the live region.
  const current = adoptBatch(batch, status)
  if (current !== batch) setBatch(current)
  const launch = useCallback((locales: string[]): void => {
    setBatch({ locales, own: true })
  }, [])
  // After a refused request there is no batch to summarize. The notice takes its place, and
  // once the notice is removed the live region must not announce the previous batch's
  // result again.
  const reset = useCallback((): void => {
    setBatch(EMPTY)
  }, [])
  return { batch: current, launch, reset }
}
