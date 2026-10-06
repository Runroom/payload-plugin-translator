import type { Block, PayloadRequest } from 'payload'

import { countChanged, countMissing } from '../core/plan.js'
import { collectTranslatables } from '../core/schema.js'
import type { TranslatableValue } from '../core/types.js'
import { docPermissions } from './docAccess.js'
import type { Entity, EntityRef } from './entity.js'
import { defaultLocaleOf, entityOf, localesOf } from './entity.js'
import { notifyLiveWrites } from './liveWrites.js'
import type { TranslationRecord } from './records.js'
import { findRecords } from './records.js'
import type { TranslatorSettings } from './settings.js'

export type LocaleStatus = {
  locale: string
  state: 'none' | 'queued' | 'running' | 'done' | 'failed'
  // Idioma desde el que se tradujo la última vez; `null` sin registro.
  sourceLocale: string | null
  stale: boolean
  changed: number
  missing: number
  error: string | null
  translatedAt: string | null
  kept: number
}

export type StatusResponse = {
  enabled: boolean
  writesLive: boolean
  // Última publicación del documento: un borrador traducido antes ya está publicado.
  // Siempre `null` sin borradores.
  lastPublishedAt: string | null
  locales: LocaleStatus[]
}

type LocaleRecord = TranslationRecord & { targetLocale: string }

type Translatables = TranslatableValue[]

const BUSY_WINDOW_MS = 15 * 60 * 1000

// Un registro en curso cuyo contenedor murió se queda en `running` para siempre; pasado
// este margen deja de bloquear una traducción nueva.
export const isBusy = (
  record: Pick<TranslationRecord, 'status' | 'updatedAt'> | undefined,
): boolean =>
  record !== undefined &&
  (record.status === 'queued' || record.status === 'running') &&
  Date.now() - Date.parse(record.updatedAt) < BUSY_WINDOW_MS

const untranslated = (locale: string): LocaleStatus => ({
  locale,
  state: 'none',
  sourceLocale: null,
  stale: false,
  changed: 0,
  missing: 0,
  error: null,
  translatedAt: null,
  kept: 0,
})

// Solo un idioma terminado se compara con su origen; en los demás no hay nada que medir.
const staleness = ({
  record,
  source,
  target,
}: {
  record: LocaleRecord
  source: Translatables | undefined
  target: Translatables | undefined
}): Pick<LocaleStatus, 'stale' | 'changed' | 'missing'> => {
  if (!source) return { stale: false, changed: 0, missing: 0 }
  const changed = countChanged({ source, hashes: record.fields ?? {} })
  const missing = target ? countMissing({ source, target }) : 0
  return { stale: changed > 0 || missing > 0, changed, missing }
}

export const INTERRUPTED_ERROR =
  'La traducción se interrumpió sin terminar; puedes volver a lanzarla'

// Un `queued`/`running` caducado ya no bloquea nada (`isBusy`), así que para la interfaz
// es un fallo que se puede reintentar, no un «Traduciendo…» eterno. Se decide al leer:
// `/status` no escribe en los registros.
const stateOf = (record: LocaleRecord): Pick<LocaleStatus, 'state' | 'error'> => {
  const pending = record.status === 'queued' || record.status === 'running'
  if (pending && !isBusy(record)) return { state: 'failed', error: INTERRUPTED_ERROR }
  return { state: record.status, error: record.error ?? null }
}

const localeStatus = ({
  locale,
  record,
  source,
  target,
}: {
  locale: string
  record: LocaleRecord | undefined
  source: Translatables | undefined
  target: Translatables | undefined
}): LocaleStatus => {
  if (!record) return untranslated(locale)
  const { state, error } = stateOf(record)
  return {
    locale,
    state,
    sourceLocale: record.sourceLocale ?? null,
    ...staleness({ record, source, target }),
    error,
    translatedAt: record.translatedAt ?? null,
    kept: record.kept?.length ?? 0,
  }
}

type Reader = (args: { locale: string; withFallback: boolean }) => Promise<Translatables>

const readerOf =
  (entity: Entity, blocks: Block[]): Reader =>
  async args =>
    collectTranslatables({ fields: entity.fields, data: await entity.read(args), blocks })

// Cada idioma terminado se compara con el texto del idioma desde el que se tradujo, que
// se lee una sola vez aunque lo compartan varios; el destino se lee sin fallback para que
// un campo vaciado a mano cuente como vacío.
const readComparisons = async ({
  read,
  done,
  defaultLocale,
}: {
  read: Reader
  done: LocaleRecord[]
  defaultLocale: string
}): Promise<{
  sourceOf: (record: LocaleRecord) => Translatables
  targets: Map<string, Translatables>
}> => {
  // Un registro terminado sin origen no debería existir; por si acaso, el idioma por defecto.
  const sourceLocaleOf = (record: LocaleRecord): string =>
    record.sourceLocale ?? defaultLocale
  const sourceLocales = [...new Set(done.map(sourceLocaleOf))]
  const [sources, targets] = await Promise.all([
    Promise.all(
      sourceLocales.map(
        async locale => [locale, await read({ locale, withFallback: true })] as const,
      ),
    ),
    Promise.all(
      done.map(
        async record =>
          [
            record.targetLocale,
            await read({ locale: record.targetLocale, withFallback: false }),
          ] as const,
      ),
    ),
  ])
  const sourceMap = new Map(sources)
  return {
    sourceOf: record => sourceMap.get(sourceLocaleOf(record))!,
    targets: new Map(targets),
  }
}

export const buildStatus = async ({
  req,
  settings,
  ref,
}: {
  req: PayloadRequest
  settings: TranslatorSettings
  ref: EntityRef
}): Promise<StatusResponse | null> => {
  const { payload } = req
  const config = localesOf(settings, ref)
  const entity = config ? entityOf(payload, ref) : null
  if (!config || !entity) return null
  const defaultLocale = defaultLocaleOf(payload)
  const [doc, records] = await Promise.all([
    entity.find({ locale: defaultLocale }),
    findRecords(payload, ref),
  ])
  if (!doc) return null
  // Sin derecho a leer el documento, el estado tampoco: para quien pregunta, no existe.
  if (!(await docPermissions({ req, ref })).read) return null
  if (entity.writesLive) await notifyLiveWrites({ req, settings, ref, records })
  const done = records.filter(item => item.status === 'done')
  // Con el permiso de lectura ya comprobado: las versiones se leen con el acceso del API
  // local, como el propio documento.
  const [{ sourceOf, targets }, lastPublishedAt] = await Promise.all([
    readComparisons({
      read: readerOf(entity, payload.config.blocks ?? []),
      done,
      defaultLocale,
    }),
    entity.lastPublishedAt(),
  ])
  return {
    enabled: settings.provider !== null,
    writesLive: entity.writesLive,
    lastPublishedAt,
    locales: config.locales.map(locale => {
      const record = records.find(item => item.targetLocale === locale)
      const isDone = record?.status === 'done'
      return localeStatus({
        locale,
        record,
        source: record && isDone ? sourceOf(record) : undefined,
        target: targets.get(locale),
      })
    }),
  }
}
