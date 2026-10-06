'use client'

import { Button } from '@payloadcms/ui'
import type { ReactElement } from 'react'

import type { LocaleStatus } from '../server/status.js'
import { Notice } from './Notice.js'
import type { Translate } from './messages.js'
import { reloadPage } from './reloadPage.js'
import { isInFlight } from './useTranslatorStatus.js'

// Vive en la barra de controles, donde una segunda línea recorta los metadatos de Payload:
// el texto visible es corto y la frase completa va al lector de pantalla (y al drawer, en
// el caso de la traducción en curso).
//
// Sigue el estado del idioma abierto, no el del lote: «lista» aparece en cuanto su
// traducción termina aunque otro idioma siga en curso. `sourceLocale` es el idioma desde
// el que se tradujo este, que es contra el que está desactualizado.
export const TargetNotice = ({
  item,
  seen,
  unpublishedDraft,
  sourceLocale,
  sourceLabel,
  t,
}: {
  item: LocaleStatus
  seen: string[]
  unpublishedDraft: boolean
  sourceLocale: string
  sourceLabel: string
  t: Translate
}): ReactElement | null => {
  if (item.state === 'none') return null
  if (isInFlight(item)) {
    return (
      <Notice
        tone="info"
        icon="progress"
        srText={t('translator:translatingThisLocale' as never)}
      >
        {t('translator:translatingShort' as never)}
      </Notice>
    )
  }
  const translatedHere = seen.includes(item.locale)
  if (translatedHere && item.state === 'done') {
    return (
      <Notice
        tone="success"
        icon="success"
        srText={t('translator:readyThisLocale' as never)}
        action={
          <Button
            buttonStyle="secondary"
            size="small"
            margin={false}
            onClick={reloadPage}
          >
            {t('translator:reload' as never)}
          </Button>
        }
      >
        {t('translator:readyShort' as never)}
      </Notice>
    )
  }
  if (translatedHere && item.state === 'failed') {
    return (
      <Notice
        tone="error"
        icon="warning"
        srText={t('translator:failed' as never, { error: item.error ?? '' })}
      >
        {t('translator:failedShort' as never)}
      </Notice>
    )
  }
  if (item.stale) {
    return (
      <Notice
        tone="warning"
        icon="warning"
        srText={t(
          (item.changed > 0
            ? 'translator:staleNotice'
            : 'translator:missingNotice') as never,
          { source: sourceLabel },
        )}
        action={
          <a className="rr-translator__notice-link" href={`?locale=${sourceLocale}`}>
            {t('translator:goToSource' as never, { source: sourceLabel })}
          </a>
        }
      >
        {t('translator:staleShort' as never)}
      </Notice>
    )
  }
  if (item.state !== 'done' || !unpublishedDraft) return null
  return (
    <Notice
      tone="info"
      icon="info"
      srText={t('translator:unpublishedThisLocale' as never)}
    >
      {t('translator:unpublishedShort' as never)}
    </Notice>
  )
}
