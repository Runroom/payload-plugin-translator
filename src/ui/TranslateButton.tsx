'use client'

import { Button } from '@payloadcms/ui'
import type { ReactElement } from 'react'

import type { LocaleStatus } from '../shared/api.js'
import { Spinner } from './Notice.js'
import type { Translate } from './messages.js'

const attentionParts = ({
  stale,
  failed,
  t,
}: {
  stale: number
  failed: number
  t: Translate
}): string[] =>
  [
    stale > 0 ? t('translator:attentionStale', { count: stale }) : null,
    failed > 0 ? t('translator:attentionFailed', { count: failed }) : null,
  ].filter((part): part is string => part !== null)

export const TranslateButton = ({
  locales,
  busy,
  language,
  onClick,
  t,
}: {
  locales: LocaleStatus[]
  busy: boolean
  language: string
  onClick: () => void
  t: Translate
}): ReactElement => {
  const stale = locales.filter(item => item.state === 'done' && item.stale).length
  const failed = locales.filter(item => item.state === 'failed').length
  const attention = busy ? [] : attentionParts({ stale, failed, t })
  return (
    <Button
      buttonStyle="secondary"
      size="medium"
      margin={false}
      className="rr-translator__toggle"
      extraButtonProps={{ 'aria-haspopup': 'dialog' }}
      onClick={onClick}
    >
      {busy ? <Spinner /> : null}
      {t(busy ? 'translator:inProgress' : 'translator:translate')}
      {attention.length > 0 ? (
        <>
          <span
            className="rr-translator__dot"
            data-tone={failed > 0 ? 'error' : 'warning'}
            aria-hidden="true"
          />{' '}
          <span className="rr-translator__sr-only">
            {'— '}
            {new Intl.ListFormat(language, { type: 'conjunction' }).format(attention)}
          </span>
        </>
      ) : null}
    </Button>
  )
}
