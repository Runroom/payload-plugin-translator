'use client'

import { Button } from '@payloadcms/ui'
import type { ReactElement } from 'react'

import type { LocaleStatus } from '../shared/api.js'
import { Notice } from './Notice.js'
import type { LocaleLink } from './localeLink.js'
import type { Translate } from './messages.js'
import { failedMessage } from './messages.js'
import { reloadPage } from './reloadPage.js'
import { isInFlight } from './useTranslatorStatus.js'

// It lives in the controls bar, where a second line clips Payload's metadata: the visible
// text is short and the full sentence goes to the screen reader (and to the drawer, for the
// translation in progress).
//
// It follows the state of the open locale, not the batch's: "ready" shows as soon as its
// translation finishes even if another locale is still in progress. `sourceLocale` is the
// locale this one was translated from, which is what it is out of date against.
type Props = {
  item: LocaleStatus
  seen: string[]
  unpublishedDraft: boolean
  sourceLocale: string
  sourceLabel: string
  linkOf: (locale: string) => LocaleLink | null
  // `false` in a nested drawer: reloading the page would reload the parent document.
  canReload: boolean
  t: Translate
}

// Reloading is the only way for the open form to get the translated text; saving without
// it makes the old form overwrite the translation. That is why it is a warning and not a
// success.
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

// A failure of the open locale is always reported, whether or not it was seen during this
// visit: also that of an interrupted translation, which is only discovered on coming back.
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
