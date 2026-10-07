'use client'

import { Button } from '@payloadcms/ui'
import type { ReactElement, ReactNode } from 'react'
import { useId, useLayoutEffect, useRef } from 'react'

import type { LocaleStatus } from '../server/status.js'
import type { Tone } from './Notice.js'
import { Spinner } from './Notice.js'
import type { LocaleLink } from './localeLink.js'
import type { Translate } from './messages.js'
import { failedMessage } from './messages.js'
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

// A locale freshly translated during this visit is the one that deserves "Review", and the
// pill says where it ended up: as a draft, pending publication, or already published if the
// entity has no drafts.
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
  // Name of the locale this one was translated from, which its state is measured against.
  sourceLabel: string
  state: RowState
  selected: boolean
  onToggle: () => void
  onRetry: () => void
  retryDescribedBy: string
  busy: boolean
  linkOf: (locale: string) => LocaleLink | null
  language: string
  t: Translate
}

const rowDetails = ({ item, sourceLabel, state, language, t }: RowProps): string[] => {
  const when = item.translatedAt
    ? formatRelative({ date: item.translatedAt, now: Date.now(), language })
    : null
  return [
    state === 'failed'
      ? t(failedMessage(item.error).key as never, failedMessage(item.error).vars)
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

// The actions wait for the end of the batch: while a locale is still in progress, "Review"
// would lead to a text the job can still rewrite and "Retry" would get a 409. They stay
// mounted but inert (`aria-disabled`, like the submit button): unmounting them would drop
// the focus of whoever just pressed "Retry" onto the `<dialog>`.
const inertProps = (busy: boolean): Record<string, string | undefined> => ({
  'aria-disabled': busy ? 'true' : undefined,
})

const ReviewAction = ({
  item,
  label,
  busy,
  linkOf,
  t,
}: Pick<RowProps, 'item' | 'label' | 'busy' | 'linkOf' | 't'>): ReactElement | null => {
  const link = linkOf(item.locale)
  if (!link) return null
  return (
    <Button
      el="anchor"
      url={link.href}
      newTab={link.newTab}
      buttonStyle="secondary"
      size="small"
      margin={false}
      className={busy ? 'btn--disabled' : undefined}
      extraButtonProps={inertProps(busy)}
      // With `onClick`, Payload's `Button` cancels the link navigation.
      onClick={busy ? (): void => {} : undefined}
    >
      {t('translator:review' as never)}{' '}
      <span className="rr-translator__sr-only">
        {label}
        {link.newTab ? ` ${t('translator:opensInNewTab' as never)}` : null}
      </span>
    </Button>
  )
}

const rowActions = (props: RowProps): ReactElement | null => {
  const { label, state, onRetry, retryDescribedBy, busy, t } = props
  if (isFreshlyDone(state)) return <ReviewAction {...props} />
  if (state === 'failed') {
    return (
      <Button
        buttonStyle="secondary"
        size="small"
        margin={false}
        className={busy ? 'btn--disabled' : undefined}
        extraButtonProps={{ ...inertProps(busy), 'aria-describedby': retryDescribedBy }}
        onClick={() => {
          if (!busy) onRetry()
        }}
      >
        {t('translator:retry' as never)}{' '}
        <span className="rr-translator__sr-only">{label}</span>
      </Button>
    )
  }
  return null
}

// When the retried locale becomes "Queued", its button disappears with the focus inside;
// the focus is returned to the checkbox of the same row. It is checked on unmount, while the
// button is still in the document, and moved afterwards only if nothing else picked it up.
const RowActions = ({
  fallbackFocus,
  children,
}: {
  fallbackFocus: { current: HTMLElement | null }
  children: ReactNode
}): ReactElement => {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const container = ref.current
    const target = fallbackFocus.current
    return (): void => {
      if (!container?.contains(document.activeElement)) return
      queueMicrotask(() => {
        const lost =
          document.activeElement === null || document.activeElement === document.body
        if (target?.isConnected && lost) target.focus()
      })
    }
  }, [fallbackFocus])
  return (
    <div ref={ref} className="rr-translator__row-actions">
      {children}
    </div>
  )
}

const LocaleRow = (props: RowProps): ReactElement => {
  const { label, state, selected, onToggle, t } = props
  const inputId = useId()
  const stateId = `${inputId}-state`
  const detailsId = `${inputId}-details`
  const checkboxRef = useRef<HTMLInputElement>(null)
  const details = rowDetails(props)
  const actions = rowActions(props)
  return (
    <li className="rr-translator__row" data-state={state}>
      <input
        ref={checkboxRef}
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
      {actions ? (
        <RowActions key={state} fallbackFocus={checkboxRef}>
          {actions}
        </RowActions>
      ) : null}
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
  linkOf,
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
  linkOf: (locale: string) => LocaleLink | null
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
            linkOf={linkOf}
            language={language}
            t={t}
          />
        ))}
      </ul>
      {/* Always mounted and empty: that way the screen reader announces the error when it appears. */}
      <p id={errorId} role="alert" className="rr-translator__field-error">
        {error}
      </p>
    </fieldset>
  )
}
