import type { Payload } from 'payload'
import { JobCancelledError, NotFound, ValidationError } from 'payload'

import type { FieldWrite } from '../core/apply.js'
import { buildUpdateData } from '../core/apply.js'
import { fingerprintOf, unitsOf } from '../core/fingerprint.js'
import {
  extractContainers,
  isLexicalState,
  MarkError,
  replaceContainers,
} from '../core/lexical.js'
import type { FieldHashes, TranslationPlan } from '../core/plan.js'
import { planTranslation } from '../core/plan.js'
import { collectTranslatables } from '../core/schema.js'
import type { TranslatableValue } from '../core/types.js'
import { translateUnits } from '../provider/translateUnits.js'
import type { TranslationProvider } from '../provider/types.js'
import { ProviderError } from '../provider/types.js'
import type { Entity, EntityRef } from './entity.js'
import { defaultLocaleOf, entityOf, localesOf } from './entity.js'
import type { RecordKey } from './records.js'
import { findRecord, saveRecord } from './records.js'
import type { TranslatorSettings } from './settings.js'

type TranslationJobInput = EntityRef & {
  sourceLocale: string
  targetLocales: string[]
  overwriteEdited: boolean
}

export type RawTranslationJobInput = Omit<
  TranslationJobInput,
  'sourceLocale' | 'targetLocales'
> & {
  sourceLocale?: string | null
  targetLocales: unknown
}

const unitIdsOf = (value: TranslatableValue): [string, string][] => {
  if (value.kind === 'text') return [[value.path, unitsOf(value)[0] ?? '']]
  const containers = isLexicalState(value.value) ? extractContainers(value.value) : []
  return containers.map((text, index) => [`${value.path}#${index}`, text])
}

const translatedValue = (
  value: TranslatableValue,
  result: Map<string, string>,
): unknown => {
  if (value.kind === 'text') return result.get(value.path)
  if (!isLexicalState(value.value)) return value.value
  const count = extractContainers(value.value).length
  const texts = Array.from(
    { length: count },
    (_, index) => result.get(`${value.path}#${index}`) ?? '',
  )
  return replaceContainers(value.value, texts)
}

type PathWrite = FieldWrite & { path: string }

const keyOf = (input: EntityRef, targetLocale: string): RecordKey => ({
  entityType: input.entityType,
  collectionSlug: input.collectionSlug,
  docId: input.docId,
  targetLocale,
})

type LocaleRun = {
  payload: Payload
  provider: TranslationProvider
  settings: TranslatorSettings
  input: TranslationJobInput
  entity: Entity
  sourceLocale: string
  targetLocale: string
}

const translatePlan = async ({
  plan,
  run: { payload, provider, settings, input, sourceLocale, targetLocale },
}: {
  plan: TranslationPlan
  run: LocaleRun
}): Promise<PathWrite[]> => {
  const units = new Map(plan.translate.flatMap(unitIdsOf))
  const withMarks = new Set(
    plan.translate
      .filter(value => value.kind === 'richText')
      .flatMap(value => unitIdsOf(value).map(([id]) => id)),
  )
  const result = await translateUnits({
    provider,
    units,
    sourceLocale,
    targetLocale,
    instructions: settings.instructions({ sourceLocale, targetLocale }),
    withMarks: id => withMarks.has(id),
    // El latido solo alarga la vida del bloqueo: perderlo no justifica tirar lo traducido.
    onBatch: async () => {
      try {
        await saveRecord(payload, {
          key: keyOf(input, targetLocale),
          data: { status: 'running' },
        })
      } catch (err) {
        payload.logger.warn({ err, msg: 'No se pudo guardar el latido de la traducción' })
      }
    },
  })
  return plan.translate.map(value => ({
    path: value.path,
    segments: value.segments,
    value: translatedValue(value, result),
  }))
}

const translatablesOf = (
  run: LocaleRun,
  doc: Record<string, unknown>,
): TranslatableValue[] =>
  collectTranslatables({
    fields: run.entity.fields,
    data: doc,
    blocks: run.payload.config.blocks ?? [],
  })

// La huella `output` sale de lo que Payload guardó, no de lo que se mandó: un hook
// `beforeChange` que normalice el valor (un `formatSlug`) dejaría la huella sin
// coincidir nunca, y en el reintento el campo pasaría a «editado a mano».
const hashesOf = ({
  plan,
  writes,
  written,
  run,
}: {
  plan: TranslationPlan
  writes: PathWrite[]
  written: Record<string, unknown>
  run: LocaleRun
}): FieldHashes => {
  const saved = translatablesOf(run, written)
  const hashes: FieldHashes = {}
  for (const value of plan.translate) {
    if (!writes.some(write => write.path === value.path)) continue
    const savedValue = saved.find(item => item.path === value.path)
    hashes[value.path] = {
      source: fingerprintOf(value)!,
      output: savedValue ? fingerprintOf(savedValue) : null,
    }
  }
  return hashes
}

class ConcurrentEditError extends Error {
  override readonly name = 'ConcurrentEditError'
}

// Payload no combina locales al guardar: cada guardado (versión o documento, según haya
// borradores) se escribe entero a partir del último, así que un guardado de otro idioma
// que se solape con el nuestro puede devolver los campos de este locale a su valor
// anterior.
const verifyWrite = async ({
  run,
  hashes,
  previous,
}: {
  run: LocaleRun
  hashes: FieldHashes
  previous: FieldHashes
}): Promise<void> => {
  const { payload, input, entity, targetLocale } = run
  const saved = await entity.read({ locale: targetLocale, withFallback: false })
  const values = translatablesOf(run, saved)
  // Un campo traducido que quedó vacío no se da por verificado: si no es nuestro texto
  // lo que hay, es que alguien lo pisó entre la escritura y esta lectura.
  const verified = Object.entries(hashes).filter(([path, { output }]) => {
    const value = values.find(item => item.path === path)
    return output !== null && (value ? fingerprintOf(value) : null) === output
  })
  if (verified.length === Object.keys(hashes).length) return
  // Sin esto, en el reintento los campos que sí quedaron escritos no coincidirían con
  // ninguna huella nuestra y pasarían a «editados a mano».
  await saveVerified({
    payload,
    key: keyOf(input, targetLocale),
    fields: { ...previous, ...Object.fromEntries(verified) },
  })
  throw new ConcurrentEditError(
    `Una edición simultánea sobrescribió la traducción de ${targetLocale}`,
  )
}

const saveVerified = async ({
  payload,
  key,
  fields,
}: {
  payload: Payload
  key: RecordKey
  fields: FieldHashes
}): Promise<void> => {
  try {
    await saveRecord(payload, { key, data: { fields } })
  } catch (err) {
    payload.logger.error({ err, msg: 'No se pudieron guardar las huellas verificadas' })
  }
}

// El destino se vuelve a leer justo antes de escribir: entre la planificación y este
// punto pasan las llamadas al proveedor, y los grupos se envían enteros, así que una
// foto vieja devolvería a su valor anterior la agenda u otros datos no localizados que
// una importación o la editora hayan cambiado mientras tanto.
const writeTranslation = async ({
  run,
  writes,
}: {
  run: LocaleRun
  writes: FieldWrite[]
}): Promise<Record<string, unknown>> => {
  const { entity, targetLocale } = run
  const targetDoc = await entity.read({ locale: targetLocale, withFallback: false })
  return entity.write({
    locale: targetLocale,
    data: buildUpdateData({ targetDoc, writes }),
  })
}

type Outcome = { hashes: FieldHashes; kept: string[]; translated: boolean }

const execute = async (run: LocaleRun, previous: FieldHashes): Promise<Outcome> => {
  const { entity, input, sourceLocale, targetLocale } = run
  const [sourceDoc, targetDoc] = await Promise.all([
    entity.read({ locale: sourceLocale, withFallback: true }),
    entity.read({ locale: targetLocale, withFallback: false }),
  ])
  const plan = planTranslation({
    source: translatablesOf(run, sourceDoc),
    target: translatablesOf(run, targetDoc),
    previous,
    overwriteEdited: input.overwriteEdited,
  })
  if (plan.translate.length === 0) {
    return { hashes: plan.hashes, kept: plan.kept, translated: false }
  }

  const writes = await translatePlan({ plan, run })
  const written = await writeTranslation({ run, writes })
  const hashes = hashesOf({ plan, writes, written, run })
  await verifyWrite({ run, hashes, previous })
  return { hashes: { ...plan.hashes, ...hashes }, kept: plan.kept, translated: true }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// Un idioma que ya falló sin remedio en este mismo job: el POST deja todos los registros
// en `queued` antes de que el job arranque, así que un `failed` al llegar aquí solo puede
// ser de un intento anterior de este job. Repetirlo gastaría proveedor para fallar igual.
class PreviousFailure extends Error {
  override readonly name = 'PreviousFailure'
}

// Sin borradores Payload valida el documento entero al guardar (un `label` obligatorio
// vacío en el destino, un validador de personas): reintentar no lo arregla.
const isUnrecoverable = (error: unknown): boolean =>
  (error instanceof ProviderError && !error.retryable) ||
  error instanceof MarkError ||
  error instanceof NotFound ||
  error instanceof ValidationError ||
  error instanceof PreviousFailure

const saveFailure = async ({
  payload,
  key,
  message,
  status = 'failed',
}: {
  payload: Payload
  key: RecordKey
  message: string
  status?: 'failed' | 'queued'
}): Promise<void> => {
  try {
    await saveRecord(payload, { key, data: { status, error: message } })
  } catch (err) {
    payload.logger.error({ err, msg: 'No se pudo guardar el fallo de la traducción' })
  }
}

// Sin nada traducido, `translatedAt` sigue siendo el de la última traducción real:
// moverlo haría que `onLiveWrite` avisara otra vez a la web sin que nada cambiase.
const saveDone = async (
  { payload, sourceLocale }: LocaleRun,
  key: RecordKey,
  { hashes, kept, translated }: Outcome,
): Promise<void> => {
  await saveRecord(payload, {
    key,
    data: {
      status: 'done',
      fields: hashes,
      kept,
      error: null,
      sourceLocale,
      ...(translated ? { translatedAt: new Date().toISOString() } : {}),
    },
  })
}

// Mientras quede un reintento el registro sigue en `queued`: así el documento sigue
// bloqueado y un POST nuevo no lanza otro job que correría en paralelo con este.
const recordFailure = async (
  { payload }: LocaleRun,
  key: RecordKey,
  { error, isLastAttempt }: { error: unknown; isLastAttempt: boolean },
): Promise<void> => {
  const willRetry = !isLastAttempt && !isUnrecoverable(error)
  const retryNote = willRetry && error instanceof ConcurrentEditError
  await saveFailure({
    payload,
    key,
    message: retryNote ? `${messageOf(error)}; se reintentará` : messageOf(error),
    status: willRetry ? 'queued' : 'failed',
  })
}

const translateLocale = async ({
  run,
  isLastAttempt,
}: {
  run: LocaleRun
  isLastAttempt: boolean
}): Promise<{ error: unknown } | null> => {
  const { payload, input, targetLocale } = run
  const key = keyOf(input, targetLocale)
  try {
    const record = await findRecord(payload, key)
    if (record?.status === 'failed') {
      return { error: new PreviousFailure(record.error ?? `Falló ${targetLocale}`) }
    }
    await saveRecord(payload, { key, data: { status: 'running', error: null } })
    await saveDone(run, key, await execute(run, record?.fields ?? {}))
    return null
  } catch (error) {
    await recordFailure(run, key, { error, isLastAttempt })
    return { error }
  }
}

const cancelAll = async ({
  payload,
  input,
  targets,
  message,
}: {
  payload: Payload
  input: RawTranslationJobInput
  targets: string[]
  message: string
}): Promise<never> => {
  for (const targetLocale of targets) {
    await saveFailure({ payload, key: keyOf(input, targetLocale), message })
  }
  throw new JobCancelledError(message)
}

// Un reintento del job vuelve a recorrer todos los idiomas, pero los ya hechos salen sin
// cambios por sus huellas: reintentar no repite llamadas al proveedor ni escrituras.
const throwFailures = (errors: unknown[]): void => {
  if (errors.length === 0) return
  const retryable = errors.find(error => !isUnrecoverable(error))
  if (retryable !== undefined) throw retryable
  throw new JobCancelledError(errors.map(messageOf).join('; '))
}

const nameOf = ({ entityType, collectionSlug }: EntityRef): string =>
  entityType === 'global'
    ? `El global ${collectionSlug}`
    : `La colección ${collectionSlug}`

const requestedLocales = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? [...new Set(raw.filter((item): item is string => typeof item === 'string'))]
    : []

type Prepared = { run: Omit<LocaleRun, 'targetLocale'>; targets: string[] }

const prepare = async ({
  payload,
  input,
  settings,
}: {
  payload: Payload
  input: RawTranslationJobInput
  settings: TranslatorSettings
}): Promise<Prepared> => {
  const name = nameOf(input)
  const requested = requestedLocales(input.targetLocales)
  const config = localesOf(settings, input)
  if (!config) {
    const message = `${name} no es traducible`
    return cancelAll({ payload, input, targets: requested, message })
  }
  // Un job encolado antes de poder elegir el origen no lo trae.
  const sourceLocale = input.sourceLocale ?? defaultLocaleOf(payload)
  const targets = requested.filter(
    locale => config.locales.includes(locale) && locale !== sourceLocale,
  )
  const cancel = (reason: string): Promise<never> =>
    cancelAll({ payload, input, targets, message: reason })
  if (!config.locales.includes(sourceLocale))
    return cancel(`${name} no se traduce desde ${sourceLocale}`)
  if (targets.length === 0)
    return cancel('La traducción no pide ningún idioma destino válido')
  const entity = entityOf(payload, input)
  if (!entity) return cancel(`${name} no existe en Payload`)
  const provider = settings.provider
  if (!provider) return cancel('El traductor no está configurado')
  return {
    run: {
      payload,
      provider,
      settings,
      input: { ...input, sourceLocale, targetLocales: targets },
      entity,
      sourceLocale,
    },
    targets,
  }
}

// Los idiomas van en serie y dentro de un solo job: cada escritura guarda el documento
// entero a partir de la última versión, y dos en paralelo sobre el mismo documento se pisan.
export const runTranslation = async ({
  payload,
  input,
  settings,
  isLastAttempt,
}: {
  payload: Payload
  input: RawTranslationJobInput
  settings: TranslatorSettings
  isLastAttempt: boolean
}): Promise<void> => {
  const { run, targets } = await prepare({ payload, input, settings })
  const errors: unknown[] = []
  for (const targetLocale of targets) {
    const failure = await translateLocale({
      run: { ...run, targetLocale },
      isLastAttempt,
    })
    if (failure) errors.push(failure.error)
  }
  throwFailures(errors)
}
