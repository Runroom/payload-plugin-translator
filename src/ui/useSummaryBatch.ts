'use client'

import { useCallback, useState } from 'react'

import type { StatusResponse } from '../server/status.js'
import { isInFlight } from './useTranslatorStatus.js'

// El lote que resume la región viva: el lanzado aquí (`own`) o el último visto en curso,
// lo lanzara quien lo lanzara.
export type SummaryBatch = { locales: string[]; own: boolean }

const EMPTY: SummaryBatch = { locales: [], own: false }

// Mientras el lote seguido sigue en curso no se cambia de lote (el servidor no deja lanzar
// otro sobre el mismo documento). Cuando ya ha terminado, el siguiente que aparezca en
// curso pasa a ser el resumido, aunque el anterior fuera propio.
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
  // Se adopta durante el render y no en un efecto: un render intermedio con el lote
  // anterior volvería a poner su resultado en la región viva.
  const current = adoptBatch(batch, status)
  if (current !== batch) setBatch(current)
  const launch = useCallback((locales: string[]): void => {
    setBatch({ locales, own: true })
  }, [])
  // Tras una petición rechazada no queda lote que resumir: el aviso ocupa su lugar y, al
  // quitarlo, la región viva no vuelve a anunciar el resultado del lote anterior.
  const reset = useCallback((): void => {
    setBatch(EMPTY)
  }, [])
  return { batch: current, launch, reset }
}
