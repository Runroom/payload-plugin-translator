import type { Block, PayloadRequest, SanitizedFieldsPermissions } from 'payload'

import { countChanged, countMissing } from '../core/plan.js'
import { collectTranslatables } from '../core/schema.js'
import type { TranslatableValue } from '../core/types.js'
import type { LocaleStatus, StatusResponse } from '../shared/api.js'
import { isPendingState } from '../shared/api.js'
import { docPermissions } from './docAccess.js'
import type { Entity, EntityRef } from './entity.js'
import { defaultLocaleOf, entityOf, localesOf } from './entity.js'
import { notifyLiveWrites } from './liveWrites.js'
import type { TranslationRecord } from './records.js'
import { findRecords } from './records.js'
import type { TranslatorSettings } from './settings.js'

type LocaleRecord = TranslationRecord & { targetLocale: string }

type Translatables = TranslatableValue[]

const BUSY_WINDOW_MS = 15 * 60 * 1000

// An in-progress record whose process died stays `running` forever; after this window it
// stops blocking a new translation.
export const isBusy = (
  record: Pick<TranslationRecord, 'status' | 'updatedAt'> | undefined,
): boolean =>
  record !== undefined &&
  isPendingState(record.status) &&
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

// Only a finished locale is compared with its source; for the rest there is nothing to measure.
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
  'The translation was interrupted before it finished; you can start it again'

// An expired `queued`/`running` record no longer blocks anything (`isBusy`), so for the UI
// it is a failure that can be retried, not an endless "Translating…". It is decided on
// read: `/status` does not write to the records.
const stateOf = (record: LocaleRecord): Pick<LocaleStatus, 'state' | 'error'> => {
  if (isPendingState(record.status) && !isBusy(record))
    return { state: 'failed', error: INTERRUPTED_ERROR }
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
  (entity: Entity, blocks: Block[], permissions: SanitizedFieldsPermissions): Reader =>
  async args =>
    collectTranslatables({
      fields: entity.fields,
      data: await entity.read(args),
      blocks,
      permissions,
    })

// Each finished locale is compared with the text of the locale it was translated from,
// which is read only once even if several share it; the target is read without fallback so
// that a field emptied by hand counts as empty.
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
  // A finished record without `sourceLocale` is compared with the default locale.
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
  // Without the right to read the document, no status either: for the requester, it does
  // not exist.
  const permissions = await docPermissions({ req, ref })
  if (!permissions.read) return null
  if (entity.writesLive) await notifyLiveWrites({ req, settings, ref, records })
  const done = records.filter(item => item.status === 'done')
  // With read permission already checked: the versions are read with the Local API's
  // access, like the document itself.
  const [{ sourceOf, targets }, lastPublishedAt] = await Promise.all([
    readComparisons({
      read: readerOf(entity, payload.config.blocks ?? [], permissions.fields),
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
