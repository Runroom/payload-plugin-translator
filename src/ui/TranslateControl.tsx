'use client'

import {
  Button,
  useConfig,
  useDocumentInfo,
  useDrawerSlug,
  useEditDepth,
  useLocale,
  useModal,
  useTranslation,
} from '@payloadcms/ui'
import type { Locale } from 'payload'
import type { ReactElement } from 'react'

import type { LocaleStatus, StatusResponse } from '../shared/api.js'
import { Notice } from './Notice.js'
import { TargetNotice } from './TargetNotice.js'
import { TranslateButton } from './TranslateButton.js'
import { TranslateDrawer } from './TranslateDrawer.js'
import { TranslateStatus } from './TranslateStatus.js'
import { localeLinkOf } from './localeLink.js'
import type { Message, Translate, TranslatorKey } from './messages.js'
import { summaryMessages } from './messages.js'
import { targetOf } from './target.js'
import { useSummaryBatch } from './useSummaryBatch.js'
import { useTranslateRequest } from './useTranslateRequest.js'
import { isInFlight, isRunning, useTranslatorStatus } from './useTranslatorStatus.js'

import './TranslateControl.css'

const localeLabel = ({
  locales,
  code,
  language,
}: {
  locales: (Locale | string)[]
  code: string
  language: string
}): string => {
  const found = locales.find(
    item => (typeof item === 'string' ? item : item.code) === code,
  )
  if (!found || typeof found === 'string') return code
  if (typeof found.label === 'string') return found.label
  return found.label[language] ?? Object.values(found.label)[0] ?? code
}

// Without drafts there is nothing left to review before publishing: it is already live.
const doneKeyOf = (status: { writesLive: boolean }): TranslatorKey =>
  status.writesLive ? 'translator:doneLive' : 'translator:done'

// The same rule Payload's bar uses to say "Draft" or "Changed" (`elements/Status`).
// Publishing sets the counter to 0 in `useDocumentInfo` without reloading.
const hasUnpublishedChanges = ({
  hasPublishedDoc,
  unpublishedVersionCount,
}: {
  hasPublishedDoc: boolean
  unpublishedVersionCount: number
}): boolean => !hasPublishedDoc || unpublishedVersionCount > 0

// Payload's counter is for the whole document: with one locale already published and
// another one in draft, it would be positive on the published one too. Only a translation
// newer than the latest publication is still unpublished.
const translatedAfterPublishing = ({
  translatedAt,
  lastPublishedAt,
}: {
  translatedAt: string | null
  lastPublishedAt: string | null | undefined
}): boolean => {
  if (!translatedAt) return false
  if (!lastPublishedAt) return true
  return Date.parse(translatedAt) > Date.parse(lastPublishedAt)
}

const STATUS_UNAVAILABLE: Message = { key: 'translator:statusUnavailable' }

const StalledNotice = ({
  onRetry,
  t,
}: {
  onRetry: () => void
  t: Translate
}): ReactElement => (
  <Notice
    tone="warning"
    icon="warning"
    srText={t(STATUS_UNAVAILABLE.key)}
    action={
      <Button buttonStyle="secondary" size="small" margin={false} onClick={onRetry}>
        {t('translator:retry')}
      </Button>
    }
  >
    {t('translator:statusUnavailableShort')}
  </Notice>
)

const unpublishedDraftOf = ({
  status,
  item,
  documentInfo,
}: {
  status: StatusResponse
  item: LocaleStatus
  documentInfo: { hasPublishedDoc: boolean; unpublishedVersionCount: number }
}): boolean =>
  !status.writesLive &&
  hasUnpublishedChanges(documentInfo) &&
  translatedAfterPublishing({
    translatedAt: item.translatedAt,
    lastPublishedAt: status.lastPublishedAt,
  })

export const TranslateControl = (): ReactElement | null => {
  const { id, collectionSlug, globalSlug, hasPublishedDoc, unpublishedVersionCount } =
    useDocumentInfo()
  const locale = useLocale()
  const { config } = useConfig()
  const { t, i18n } = useTranslation()
  const { openModal, isModalOpen } = useModal()
  const editDepth = useEditDepth()
  const drawerSlug = useDrawerSlug('translator')
  // Payload types `t` with its own key union, which ours is a subset of.
  const translate = t as unknown as Translate
  const apiBase = `${config.serverURL ?? ''}${config.routes.api}`
  const target = targetOf({ id, collectionSlug, globalSlug })
  const { status, refresh, markQueued, seen, stalled, retry } = useTranslatorStatus({
    apiBase,
    target,
  })
  const { batch, launch, reset } = useSummaryBatch(status)
  const request = useTranslateRequest({
    apiBase,
    target,
    sourceLocale: locale.code,
    markQueued,
    refresh,
    onLaunched: launch,
    onRefused: reset,
  })

  if (!status?.enabled) return null
  // The open locale is the source; the others, the drawer's targets. Its own record (if
  // someone translated it from another locale) feeds the bar's notice. A locale the entity
  // does not translate cannot be the source: the server would answer 400.
  const current = status.locales.find(item => item.locale === locale.code)
  if (!current) return null

  const labelOf = (code: string): string =>
    localeLabel({
      locales: config.localization ? config.localization.locales : [],
      code,
      language: i18n.language,
    })
  // A record without `sourceLocale` is measured against the default locale.
  const sourceOf = (item: LocaleStatus): string =>
    item.sourceLocale ??
    (config.localization ? config.localization.defaultLocale : locale.code)
  const sourceLabelOf = (item: LocaleStatus): string => labelOf(sourceOf(item))
  const linkOf = localeLinkOf({ editDepth, adminRoute: config.routes.admin, target })

  const others = status.locales.filter(item => item.locale !== locale.code)
  const running = isRunning(status)
  const busy = request.submitting || running
  const summary = summaryMessages({
    status,
    requested: batch.locales,
    notice: request.notice,
    doneKey: batch.own ? doneKeyOf(status) : 'translator:finished',
  })
  // With polling stopped, "Translating…" is no longer true: it announces the status is unknown.
  const messages = stalled && !request.notice ? [STATUS_UNAVAILABLE] : summary

  return (
    <div className="rr-translator">
      {stalled ? <StalledNotice onRetry={retry} t={translate} /> : null}
      <TargetNotice
        item={current}
        seen={seen}
        unpublishedDraft={unpublishedDraftOf({
          status,
          item: current,
          documentInfo: { hasPublishedDoc, unpublishedVersionCount },
        })}
        sourceLocale={sourceOf(current)}
        sourceLabel={sourceLabelOf(current)}
        linkOf={linkOf}
        canReload={editDepth <= 1}
        t={translate}
      />
      <TranslateButton
        locales={others}
        busy={busy}
        language={i18n.language}
        onClick={() => {
          request.clearNotice()
          openModal(drawerSlug)
        }}
        t={translate}
      />
      <TranslateStatus
        messages={messages}
        silenced={isModalOpen(drawerSlug)}
        t={translate}
      />
      <TranslateDrawer
        slug={drawerSlug}
        title={translate('translator:drawerTitle', {
          source: labelOf(locale.code),
        })}
        status={{ ...status, locales: others }}
        translated={[...new Set([...request.translated, ...seen])]}
        busy={busy}
        notice={
          isInFlight(current) ? (
            <Notice tone="info" icon="progress">
              {translate('translator:translatingThisLocale')}
            </Notice>
          ) : null
        }
        messages={messages}
        labelOf={labelOf}
        sourceLabelOf={sourceLabelOf}
        language={i18n.language}
        linkOf={linkOf}
        refresh={refresh}
        send={request.send}
        t={translate}
      />
    </div>
  )
}
