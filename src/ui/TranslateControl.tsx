'use client'

import {
  useConfig,
  useDocumentInfo,
  useDrawerSlug,
  useLocale,
  useModal,
  useTranslation,
} from '@payloadcms/ui'
import type { Locale } from 'payload'
import type { ReactElement } from 'react'

import type { LocaleStatus } from '../server/status.js'
import { Notice } from './Notice.js'
import { TargetNotice } from './TargetNotice.js'
import { TranslateButton } from './TranslateButton.js'
import { TranslateDrawer } from './TranslateDrawer.js'
import { TranslateStatus } from './TranslateStatus.js'
import type { Translate } from './messages.js'
import { summaryMessages } from './messages.js'
import { targetOf } from './target.js'
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

// Sin borradores no queda nada por revisar antes de publicar: ya está publicado.
const doneKeyOf = (status: { writesLive: boolean }): string =>
  status.writesLive ? 'translator:doneLive' : 'translator:done'

// La misma regla con la que la barra de Payload dice «Borrador» o «Cambiado»
// (`elements/Status`). Publicar pone el contador a 0 en `useDocumentInfo` sin recargar.
const hasUnpublishedChanges = ({
  hasPublishedDoc,
  unpublishedVersionCount,
}: {
  hasPublishedDoc: boolean
  unpublishedVersionCount: number
}): boolean => !hasPublishedDoc || unpublishedVersionCount > 0

export const TranslateControl = (): ReactElement | null => {
  const { id, collectionSlug, globalSlug, hasPublishedDoc, unpublishedVersionCount } =
    useDocumentInfo()
  const locale = useLocale()
  const { config } = useConfig()
  const { t, i18n } = useTranslation()
  const { openModal } = useModal()
  const drawerSlug = useDrawerSlug('translator')
  const translate = t as unknown as Translate
  const apiBase = `${config.serverURL ?? ''}${config.routes.api}`
  const target = targetOf({ id, collectionSlug, globalSlug })
  const { status, refresh, markQueued, seen } = useTranslatorStatus({ apiBase, target })
  const request = useTranslateRequest({
    apiBase,
    target,
    sourceLocale: locale.code,
    markQueued,
    refresh,
  })

  if (!status?.enabled) return null

  const labelOf = (code: string): string =>
    localeLabel({
      locales: config.localization ? config.localization.locales : [],
      code,
      language: i18n.language,
    })
  // Un registro terminado sin origen no debería existir; por si acaso, el idioma por defecto.
  const sourceOf = (item: LocaleStatus): string =>
    item.sourceLocale ??
    (config.localization ? config.localization.defaultLocale : locale.code)
  const sourceLabelOf = (item: LocaleStatus): string => labelOf(sourceOf(item))

  // El idioma abierto es el origen; los demás, los destinos del drawer. Su propio registro
  // (si alguien lo tradujo desde otro idioma) alimenta el aviso de la barra.
  const current = status.locales.find(item => item.locale === locale.code)
  const others = status.locales.filter(item => item.locale !== locale.code)
  const running = isRunning(status)
  const busy = request.submitting || running
  // Sin petición propia en esta visita, el lote es el que se ha visto en curso: también se
  // anuncia al terminar aunque lo lanzara otra persona o desde otra pestaña.
  const launchedHere = request.requested.length > 0
  const messages = summaryMessages({
    status,
    requested: launchedHere ? request.requested : seen,
    notice: request.notice,
    doneKey: launchedHere ? doneKeyOf(status) : 'translator:finished',
  })

  return (
    <div className="rr-translator">
      {current ? (
        <TargetNotice
          item={current}
          seen={seen}
          unpublishedDraft={
            !status.writesLive &&
            hasUnpublishedChanges({ hasPublishedDoc, unpublishedVersionCount })
          }
          sourceLocale={sourceOf(current)}
          sourceLabel={sourceLabelOf(current)}
          t={translate}
        />
      ) : null}
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
      <TranslateStatus messages={messages} t={translate} />
      <TranslateDrawer
        slug={drawerSlug}
        title={translate('translator:drawerTitle' as never, {
          source: labelOf(locale.code),
        })}
        status={{ ...status, locales: others }}
        translated={[...new Set([...request.translated, ...seen])]}
        busy={busy}
        notice={
          current && isInFlight(current) ? (
            <Notice tone="info" icon="progress">
              {translate('translator:translatingThisLocale' as never)}
            </Notice>
          ) : null
        }
        messages={messages}
        labelOf={labelOf}
        sourceLabelOf={sourceLabelOf}
        language={i18n.language}
        refresh={refresh}
        send={request.send}
        t={translate}
      />
    </div>
  )
}
