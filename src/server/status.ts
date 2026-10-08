import type { PayloadRequest } from 'payload'

import { mergeFieldPermissions } from '../core/permissions.js'
import { countChanged, countMissing } from '../core/plan.js'
import { collectTranslatables } from '../core/schema.js'
import type { TranslatableValue } from '../core/types.js'
import type { LocaleStatus, StatusResponse } from '../shared/api.js'
import { isPendingState } from '../shared/api.js'
import type { DocPermissions } from './docAccess.js'
import { docPermissions } from './docAccess.js'
import type { Entity, EntityRef } from './entity.js'
import { defaultLocaleOf, entityOf, localesOf } from './entity.js'
import { BUSY_WINDOW_MS } from './limits.js'
import { notifyLiveWrites } from './liveWrites.js'
import { findLock, isLiveLock } from './lock.js'
import type { TranslationRecord } from './records.js'
import { findRecords } from './records.js'
import type { TranslatorSettings } from './settings.js'

type LocaleRecord = TranslationRecord & { targetLocale: string }

type Translatables = TranslatableValue[]

// A record whose process died stays `running` forever, so it stops blocking a new
// translation once the busy window has passed.
const isBusy = (
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

type Comparison = { source: Translatables; target: Translatables; sourceLocale: string }

// Only finished locales are compared with their source; the rest have nothing to measure.
const staleness = ({
  record,
  comparison,
}: {
  record: LocaleRecord
  comparison: Comparison | undefined
}): Pick<LocaleStatus, 'stale' | 'changed' | 'missing'> => {
  if (!comparison) return { stale: false, changed: 0, missing: 0 }
  const { source, target, sourceLocale } = comparison
  const changed = countChanged({ source, hashes: record.fields ?? {}, sourceLocale })
  const missing = countMissing({ source, target })
  return { stale: changed > 0 || missing > 0, changed, missing }
}

const INTERRUPTED_ERROR =
  'The translation was interrupted before it finished; you can start it again'

// A `queued`/`running` record is still pending while the document's lock has a heartbeat:
// the job refreshes the lock, not the records of the locales still to come, so in a long
// job those pass the busy window before their turn. Without a live lock an expired record
// no longer blocks anything (`isBusy`), so the UI shows it as a failure that can be
// retried instead of an endless "Translating…". This is decided on read; `/status` never
// writes to the records.
const stateOf = (
  record: LocaleRecord,
  locked: boolean,
): Pick<LocaleStatus, 'state' | 'error'> => {
  if (isPendingState(record.status) && !locked && !isBusy(record))
    return { state: 'failed', error: INTERRUPTED_ERROR }
  return { state: record.status, error: record.error ?? null }
}

const localeStatus = ({
  locale,
  record,
  comparison,
  locked,
}: {
  locale: string
  record: LocaleRecord | undefined
  comparison: Comparison | undefined
  locked: boolean
}): LocaleStatus => {
  if (!record) return untranslated(locale)
  const { state, error } = stateOf(record, locked)
  return {
    locale,
    state,
    sourceLocale: record.sourceLocale ?? null,
    ...staleness({ record, comparison }),
    error,
    translatedAt: record.translatedAt ?? null,
    kept: record.kept?.length ?? 0,
  }
}

type LocaleAccess = Map<string, DocPermissions>

// Access rules may depend on `req.locale`, so read permission is decided per locale. The
// checks run one after the other: each one sets the locale on the shared request.
const accessByLocale = async ({
  req,
  ref,
  locales,
}: {
  req: PayloadRequest
  ref: EntityRef
  locales: string[]
}): Promise<LocaleAccess> => {
  const access: LocaleAccess = new Map()
  for (const locale of locales) {
    access.set(locale, await docPermissions({ req, ref, locale }))
  }
  return access
}

const canRead = (access: LocaleAccess, locale: string): boolean =>
  access.get(locale)?.read === true

type Doc = Record<string, unknown>

// The documents the comparisons need, one per locale the requester may read: sources
// with fallback, targets without so a field emptied by hand counts as empty. A source
// shared by several locales is read once.
const readDocs = async ({
  entity,
  access,
  sourceLocales,
  targetLocales,
}: {
  entity: Entity
  access: LocaleAccess
  sourceLocales: string[]
  targetLocales: string[]
}): Promise<{ sources: Map<string, Doc>; targets: Map<string, Doc> }> => {
  const read = async (
    locales: string[],
    withFallback: boolean,
  ): Promise<Map<string, Doc>> =>
    new Map(
      await Promise.all(
        [...new Set(locales)]
          .filter(locale => canRead(access, locale))
          .map(
            async locale =>
              [locale, await entity.read({ locale, withFallback })] as const,
          ),
      ),
    )
  const [sources, targets] = await Promise.all([
    read(sourceLocales, true),
    read(targetLocales, false),
  ])
  return { sources, targets }
}

// A finished locale is compared with the text of the locale it was translated from, with
// the fields the requester may read there and update in the target, as a translation
// would. Without read permission on either locale there is nothing to compare: the counts
// would tell about text the requester may not see.
const comparisons = async ({
  req,
  entity,
  access,
  done,
  sourceLocaleOf,
}: {
  req: PayloadRequest
  entity: Entity
  access: LocaleAccess
  done: LocaleRecord[]
  sourceLocaleOf: (record: LocaleRecord) => string
}): Promise<Map<string, Comparison>> => {
  const { sources, targets } = await readDocs({
    entity,
    access,
    sourceLocales: done.map(sourceLocaleOf),
    targetLocales: done.map(record => record.targetLocale),
  })
  const blocks = req.payload.config.blocks ?? []
  const result = new Map<string, Comparison>()
  for (const record of done) {
    const sourceLocale = sourceLocaleOf(record)
    const source = sources.get(sourceLocale)
    const target = targets.get(record.targetLocale)
    if (!source || !target) continue
    const permissions = mergeFieldPermissions(
      access.get(sourceLocale)!.fields,
      access.get(record.targetLocale)!.fields,
    )
    const collect = (data: Doc): Translatables =>
      collectTranslatables({ fields: entity.fields, data, blocks, permissions })
    result.set(record.targetLocale, {
      source: collect(source),
      target: collect(target),
      sourceLocale,
    })
  }
  return result
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
  // Read as the requester, so Payload applies their access rules to what is compared.
  const entity = config ? entityOf(payload, ref, { user: req.user ?? undefined }) : null
  if (!config || !entity) return null
  const defaultLocale = defaultLocaleOf(payload)
  const [doc, records, lock] = await Promise.all([
    entity.find({ locale: defaultLocale }),
    findRecords(payload, ref),
    findLock(payload, ref),
  ])
  if (!doc) return null
  const locked = lock !== null && isLiveLock(lock)
  const done = records.filter(item => item.status === 'done')
  // A finished record without `sourceLocale` is compared with the default locale.
  const sourceLocaleOf = (record: LocaleRecord): string =>
    record.sourceLocale ?? defaultLocale
  const access = await accessByLocale({
    req,
    ref,
    locales: [...new Set([...config.locales, ...done.map(sourceLocaleOf)])],
  })
  // A requester who cannot read the document in any of its locales gets no status, as if
  // it did not exist. One readable locale is enough: the others are reported without
  // comparison data.
  if (!config.locales.some(locale => canRead(access, locale))) return null
  if (entity.writesLive) await notifyLiveWrites({ req, settings, ref, records })
  const [compared, lastPublishedAt] = await Promise.all([
    comparisons({ req, entity, access, done, sourceLocaleOf }),
    entity.lastPublishedAt(),
  ])
  return {
    enabled: settings.provider !== null,
    writesLive: entity.writesLive,
    lastPublishedAt,
    locales: config.locales.map(locale =>
      localeStatus({
        locale,
        record: records.find(item => item.targetLocale === locale),
        comparison: compared.get(locale),
        locked,
      }),
    ),
  }
}
