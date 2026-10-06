'use client'

import { Button } from '@payloadcms/ui'
import type { ReactElement } from 'react'

import type { LocaleStatus } from '../server/status.js'
import { Notice } from './Notice.js'
import type { LocaleLink } from './localeLink.js'
import type { Translate } from './messages.js'
import { failedMessage } from './messages.js'
import { reloadPage } from './reloadPage.js'
import { isInFlight } from './useTranslatorStatus.js'

// Vive en la barra de controles, donde una segunda línea recorta los metadatos de Payload:
// el texto visible es corto y la frase completa va al lector de pantalla (y al drawer, en
// el caso de la traducción en curso).
//
// Sigue el estado del idioma abierto, no el del lote: «lista» aparece en cuanto su
// traducción termina aunque otro idioma siga en curso. `sourceLocale` es el idioma desde
// el que se tradujo este, que es contra el que está desactualizado.
type Props = {
  item: LocaleStatus
  seen: string[]
  unpublishedDraft: boolean
  sourceLocale: string
  sourceLabel: string
  linkOf: (locale: string) => LocaleLink | null
  // `false` en un drawer anidado: recargar la página recargaría el documento padre.
  canReload: boolean
  t: Translate
}

// Recargar es la única forma de que el formulario abierto tenga el texto traducido; si se
// guarda sin hacerlo, el formulario viejo pisa la traducción. Por eso es un aviso y no un
// éxito.
const ReadyNotice = ({ canReload, t }: Pick<Props, 'canReload' | 't'>): ReactElement => (
  <Notice
    tone="warning"
    icon="warning"
    srText={t(
      (canReload
        ? 'translator:readyThisLocale'
        : 'translator:readyNestedThisLocale') as never,
    )}
    action={
      canReload ? (
        <Button buttonStyle="secondary" size="small" margin={false} onClick={reloadPage}>
          {t('translator:reload' as never)}
        </Button>
      ) : null
    }
  >
    {t((canReload ? 'translator:readyShort' : 'translator:readyNestedShort') as never)}
  </Notice>
)

const StaleNotice = ({
  item,
  sourceLocale,
  sourceLabel,
  linkOf,
  t,
}: Pick<
  Props,
  'item' | 'sourceLocale' | 'sourceLabel' | 'linkOf' | 't'
>): ReactElement => {
  const link = linkOf(sourceLocale)
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
        link ? (
          <a
            className="rr-translator__notice-link"
            href={link.href}
            {...(link.newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          >
            {t('translator:goToSource' as never, { source: sourceLabel })}
            {link.newTab ? (
              <span className="rr-translator__sr-only">
                {' '}
                {t('translator:opensInNewTab' as never)}
              </span>
            ) : null}
          </a>
        ) : null
      }
    >
      {t('translator:staleShort' as never)}
    </Notice>
  )
}

// Un fallo del idioma abierto se avisa siempre, se viera o no en esta visita: también el
// de una traducción interrumpida, que solo se descubre al volver.
export const TargetNotice = ({
  item,
  seen,
  unpublishedDraft,
  sourceLocale,
  sourceLabel,
  linkOf,
  canReload,
  t,
}: Props): ReactElement | null => {
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
  if (item.state === 'failed') {
    const failure = failedMessage(item.error)
    return (
      <Notice tone="error" icon="warning" srText={t(failure.key as never, failure.vars)}>
        {t('translator:failedShort' as never)}
      </Notice>
    )
  }
  if (seen.includes(item.locale)) return <ReadyNotice canReload={canReload} t={t} />
  if (item.stale) {
    return (
      <StaleNotice
        item={item}
        sourceLocale={sourceLocale}
        sourceLabel={sourceLabel}
        linkOf={linkOf}
        t={t}
      />
    )
  }
  if (!unpublishedDraft) return null
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
