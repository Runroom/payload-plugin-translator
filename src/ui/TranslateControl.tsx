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
import { TranslatorProvider, useTranslator } from './TranslatorContext.js'
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

// Without drafts there is nothing to review before publishing; the translation is already
// live.
const doneKeyOf = (status: { writesLive: boolean }): TranslatorKey =>
  status.writesLive ? 'translator:doneLive' : 'translator:done'

// The rule Payload's bar uses to show "Draft" or "Changed" (`elements/Status`). Publishing
// resets the counter in `useDocumentInfo` to 0 without a reload.
const hasUnpublishedChanges = ({
  hasPublishedDoc,
  unpublishedVersionCount,
}: {
  hasPublishedDoc: boolean
  unpublishedVersionCount: number
}): boolean => !hasPublishedDoc || unpublishedVersionCount > 0

// Payload's counter covers the whole document, so with one locale published and another in
// draft it is positive on the published locale too. Only a translation newer than the
// latest publication is still unpublished.
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

const StalledNotice = ({ onRetry }: { onRetry: () => void }): ReactElement => {
  const { t } = useTranslator()
  return (
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
}

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

/**
 * The admin component the plugin registers before the document controls of every
 * configured collection and global. It is not meant to be imported directly.
 */
export const TranslateControl = (): ReactElement | null => {
  const { id, collectionSlug, globalSlug, hasPublishedDoc, unpublishedVersionCount } =
    useDocumentInfo()
  const locale = useLocale()
  const { config } = useConfig()
  const { t, i18n } = useTranslation()
  const { openModal, isModalOpen } = useModal()
  const editDepth = useEditDepth()
  const drawerSlug = useDrawerSlug('translator')
  // Payload types `t` with its own key union; ours is a subset of it.
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
  // The open locale is the source and the others are the drawer's targets. Its own record
  // (if it was translated from another locale) feeds the bar's notice. A locale the entity
  // does not translate cannot be the source, since the server would answer 400.
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
  // With polling stopped, "Translating…" may no longer be true, so announce that the status
  // is unknown.
  const messages = stalled && !request.notice ? [STATUS_UNAVAILABLE] : summary

  return (
    <TranslatorProvider
      value={{ t: translate, language: i18n.language, labelOf, sourceLabelOf, linkOf }}
    >
      <div className="rr-translator">
        {stalled ? <StalledNotice onRetry={retry} /> : null}
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
          canReload={editDepth <= 1}
        />
        <TranslateButton
          locales={others}
          busy={busy}
          onClick={() => {
            request.clearNotice()
            openModal(drawerSlug)
          }}
        />
        <TranslateStatus messages={messages} silenced={isModalOpen(drawerSlug)} />
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
          refresh={refresh}
          send={request.send}
        />
      </div>
    </TranslatorProvider>
  )
}
