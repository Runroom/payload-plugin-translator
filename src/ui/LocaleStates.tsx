'use client'

import { Button } from '@payloadcms/ui'
import type { ReactElement } from 'react'
import { useId } from 'react'

import type { LocaleStatus } from '../server/status.js'
import type { Tone } from './Notice.js'
import { Spinner } from './Notice.js'
import type { Translate } from './messages.js'
import { formatRelative } from './relativeTime.js'

type RowState =
  | 'none'
  | 'upToDate'
  | 'stale'
  | 'queued'
  | 'running'
  | 'draftReady'
  | 'published'
  | 'failed'

const STATES: Record<RowState, { key: string; tone: Tone }> = {
  none: { key: 'translator:stateNone', tone: 'neutral' },
  upToDate: { key: 'translator:stateUpToDate', tone: 'success' },
  stale: { key: 'translator:stateStale', tone: 'warning' },
  queued: { key: 'translator:stateQueued', tone: 'info' },
  running: { key: 'translator:stateRunning', tone: 'info' },
  draftReady: { key: 'translator:stateDraftReady', tone: 'success' },
  published: { key: 'translator:statePublished', tone: 'success' },
  failed: { key: 'translator:stateFailed', tone: 'error' },
}

const isFreshlyDone = (state: RowState): boolean =>
  state === 'draftReady' || state === 'published'

// Recién traducida en esta visita es la que merece «Revisar», y la pill dice dónde quedó:
// en borrador, pendiente de publicar, o ya publicada si la entidad no tiene borradores.
const rowState = ({
  item,
  translated,
  writesLive,
}: {
  item: LocaleStatus
  translated: string[]
  writesLive: boolean
}): RowState => {
  if (item.state !== 'done') return item.state
  if (item.stale) return 'stale'
  if (!translated.includes(item.locale)) return 'upToDate'
  return writesLive ? 'published' : 'draftReady'
}

export const isUpToDate = (item: LocaleStatus): boolean =>
  item.state === 'done' && !item.stale

type RowProps = {
  item: LocaleStatus
  label: string
  // Nombre del idioma desde el que se tradujo este, que es contra el que se mide su estado.
  sourceLabel: string
  state: RowState
  selected: boolean
  onToggle: () => void
  onRetry: () => void
  retryDescribedBy: string
  busy: boolean
  language: string
  t: Translate
}

const rowDetails = ({ item, sourceLabel, state, language, t }: RowProps): string[] => {
  const when = item.translatedAt
    ? formatRelative({ date: item.translatedAt, now: Date.now(), language })
    : null
  return [
    state === 'failed'
      ? t('translator:failed' as never, { error: item.error ?? '' })
      : null,
    state === 'stale' && item.changed > 0
      ? t('translator:changedCount' as never, {
          count: item.changed,
          source: sourceLabel,
        })
      : null,
    state === 'stale' && item.missing > 0
      ? t('translator:missingCount' as never, { count: item.missing })
      : null,
    when ? t('translator:translatedFrom' as never, { source: sourceLabel, when }) : null,
    item.kept > 0 ? t('translator:keptCount' as never, { count: item.kept }) : null,
  ].filter((text): text is string => text !== null)
}

const StatePill = ({
  id,
  state,
  t,
}: {
  id: string
  state: RowState
  t: Translate
}): ReactElement => (
  <span id={id} className="rr-translator__pill" data-tone={STATES[state].tone}>
    {state === 'running' ? (
      <Spinner />
    ) : (
      <span className="rr-translator__pill-dot" aria-hidden="true" />
    )}
    {t(STATES[state].key as never)}
  </span>
)

// Las acciones esperan al final del lote: mientras quede un idioma en curso, «Revisar»
// llevaría a un texto que el job aún puede reescribir y «Reintentar» daría 409.
const rowActions = ({
  item,
  label,
  state,
  onRetry,
  retryDescribedBy,
  busy,
  t,
}: RowProps): ReactElement | null => {
  if (busy) return null
  if (isFreshlyDone(state)) {
    return (
      <Button
        el="anchor"
        url={`?locale=${item.locale}`}
        buttonStyle="secondary"
        size="small"
        margin={false}
      >
        {t('translator:review' as never)}{' '}
        <span className="rr-translator__sr-only">{label}</span>
      </Button>
    )
  }
  if (state === 'failed') {
    return (
      <Button
        buttonStyle="secondary"
        size="small"
        margin={false}
        extraButtonProps={{ 'aria-describedby': retryDescribedBy }}
        onClick={onRetry}
      >
        {t('translator:retry' as never)}{' '}
        <span className="rr-translator__sr-only">{label}</span>
      </Button>
    )
  }
  return null
}

const LocaleRow = (props: RowProps): ReactElement => {
  const { label, state, selected, onToggle, t } = props
  const inputId = useId()
  const stateId = `${inputId}-state`
  const detailsId = `${inputId}-details`
  const details = rowDetails(props)
  const actions = rowActions(props)
  return (
    <li className="rr-translator__row" data-state={state}>
      <input
        id={inputId}
        type="checkbox"
        className="rr-translator__checkbox"
        checked={selected}
        aria-describedby={details.length > 0 ? `${stateId} ${detailsId}` : stateId}
        onChange={onToggle}
      />
      <div className="rr-translator__row-main">
        <div className="rr-translator__row-title">
          <label htmlFor={inputId} className="rr-translator__row-label">
            {label}
          </label>
          <StatePill id={stateId} state={state} t={t} />
        </div>
        {details.length > 0 ? (
          <p id={detailsId} className="rr-translator__row-details">
            {details.map(text => (
              <span key={text} className="rr-translator__detail">
                {text}
              </span>
            ))}
          </p>
        ) : null}
      </div>
      {actions ? <div className="rr-translator__row-actions">{actions}</div> : null}
    </li>
  )
}

export const LocaleStates = ({
  locales,
  labelOf,
  sourceLabelOf,
  selected,
  translated,
  busy,
  error,
  language,
  onToggle,
  onRetry,
  retryDescribedBy,
  writesLive,
  t,
}: {
  locales: LocaleStatus[]
  labelOf: (code: string) => string
  sourceLabelOf: (item: LocaleStatus) => string
  selected: string[]
  translated: string[]
  busy: boolean
  error: string | null
  language: string
  onToggle: (code: string) => void
  onRetry: (code: string) => void
  retryDescribedBy: string
  writesLive: boolean
  t: Translate
}): ReactElement => {
  const errorId = useId()
  return (
    <fieldset
      className="rr-translator__section"
      aria-describedby={error ? errorId : undefined}
    >
      <legend className="rr-translator__section-title">
        {t('translator:languages' as never)}
      </legend>
      <ul className="rr-translator__rows">
        {locales.map(item => (
          <LocaleRow
            key={item.locale}
            item={item}
            label={labelOf(item.locale)}
            sourceLabel={sourceLabelOf(item)}
            state={rowState({ item, translated, writesLive })}
            selected={selected.includes(item.locale)}
            onToggle={() => onToggle(item.locale)}
            onRetry={() => onRetry(item.locale)}
            retryDescribedBy={retryDescribedBy}
            busy={busy}
            language={language}
            t={t}
          />
        ))}
      </ul>
      {/* Montado siempre y vacío: así el lector de pantalla anuncia el error al aparecer. */}
      <p id={errorId} role="alert" className="rr-translator__field-error">
        {error}
      </p>
    </fieldset>
  )
}
