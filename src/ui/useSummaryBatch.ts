'use client'

import { useCallback, useState } from 'react'

import type { StatusResponse } from '../server/status.js'
import { isInFlight } from './useTranslatorStatus.js'

// The batch the live region summarizes: the one started here (`own`) or the last one seen
// in progress, whoever started it.
export type SummaryBatch = { locales: string[]; own: boolean }

const EMPTY: SummaryBatch = { locales: [], own: false }

// While the followed batch is still in progress the batch does not change (the server does
// not allow starting another one on the same document). Once it has finished, the next one
// that shows up in progress becomes the summarized one, even if the previous one was our
// own.
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
  // Adopted during render and not in an effect: an intermediate render with the previous
  // batch would put its result back into the live region.
  const current = adoptBatch(batch, status)
  if (current !== batch) setBatch(current)
  const launch = useCallback((locales: string[]): void => {
    setBatch({ locales, own: true })
  }, [])
  // After a refused request there is no batch left to summarize: the notice takes its place
  // and, when it is removed, the live region does not announce the previous batch's result
  // again.
  const reset = useCallback((): void => {
    setBatch(EMPTY)
  }, [])
  return { batch: current, launch, reset }
}
