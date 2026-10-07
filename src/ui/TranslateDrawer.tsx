'use client'

import { Button, Drawer, useModal, XIcon } from '@payloadcms/ui'
import type { ReactElement, ReactNode } from 'react'
import { useEffect, useId, useRef, useState } from 'react'

import type { StatusResponse } from '../shared/api.js'
import { isUpToDate, LocaleStates } from './LocaleStates.js'
import { MessageList } from './MessageList.js'
import { Notice } from './Notice.js'
import { TranslateOptions } from './TranslateOptions.js'
import { useTranslator } from './TranslatorContext.js'
import type { Message } from './messages.js'
import { defaultOptionValues, TRANSLATE_OPTIONS } from './options.js'
import type { SendTranslation } from './useTranslateRequest.js'

type DrawerProps = {
  slug: string
  title: string
  status: StatusResponse
  translated: string[]
  busy: boolean
  notice: ReactNode
  messages: Message[]
  refresh: () => Promise<void>
  send: SendTranslation
}

// Payload's `Drawer` gives the dialog an `aria-label` equal to the slug, which is what
// screen readers would announce, so the dialog is labelled by the visible title instead.
const DrawerHeader = ({
  slug,
  title,
}: Pick<DrawerProps, 'slug' | 'title'>): ReactElement => {
  const { t } = useTranslator()
  const { closeModal } = useModal()
  const titleId = useId()
  const titleRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    titleRef.current?.closest('dialog')?.setAttribute('aria-labelledby', titleId)
  }, [titleId])
  return (
    <div className="drawer__header">
      <h2 ref={titleRef} id={titleId} className="drawer__header__title">
        {title}
      </h2>
      <button
        type="button"
        className="drawer__header__close"
        aria-label={t('general:close')}
        onClick={() => closeModal(slug)}
      >
        <XIcon />
      </button>
    </div>
  )
}

// The bar's live region is outside the `<dialog aria-modal>`, and some screen readers
// announce nothing outside the modal, so this region takes over while the drawer is open.
const Summary = ({ messages }: Pick<DrawerProps, 'messages'>): ReactElement => (
  <div role="status" className="rr-translator__summary">
    <MessageList messages={messages} />
  </div>
)

// Always styled as primary, because a grey button with no locales checked looked broken.
// It only looks inactive while a translation is in progress, and then a hint says why. It
// uses `aria-disabled` rather than `disabled` so the pressed button keeps the focus inside
// the drawer while sending.
const SubmitFooter = ({
  busy,
  messages,
  describedBy,
  onSubmit,
}: Pick<DrawerProps, 'busy' | 'messages'> & {
  describedBy: string
  onSubmit: () => void
}): ReactElement => {
  const { t } = useTranslator()
  const hintId = useId()
  return (
    <div className="rr-translator__footer">
      <Button
        buttonStyle="primary"
        size="medium"
        margin={false}
        className={busy ? 'btn--disabled' : undefined}
        extraButtonProps={{
          'aria-disabled': busy ? 'true' : undefined,
          'aria-describedby': busy ? `${hintId} ${describedBy}` : describedBy,
        }}
        onClick={() => {
          if (!busy) onSubmit()
        }}
      >
        {t('translator:submit')}
      </Button>
      <div className="rr-translator__footer-text">
        {busy ? (
          <p id={hintId} className="rr-translator__busy-hint">
            {t('translator:busyHint')}
          </p>
        ) : null}
        <Summary messages={messages} />
      </div>
    </div>
  )
}

// Mounted only while the drawer is open, so the selection and options start fresh every
// time and the status is fetched again in case the source changed without a reload.
const DrawerBody = ({
  status,
  translated,
  busy,
  notice,
  messages,
  refresh,
  send,
}: DrawerProps): ReactElement => {
  const { t } = useTranslator()
  const [selected, setSelected] = useState<string[] | null>(null)
  const [options, setOptions] = useState(defaultOptionValues)
  const [missingLanguage, setMissingLanguage] = useState(false)
  const modeDescription = useId()
  useEffect(() => {
    void refresh()
  }, [refresh])

  const chosen =
    selected ?? status.locales.filter(item => !isUpToDate(item)).map(item => item.locale)
  const translate = async (targetLocales: string[]): Promise<void> => {
    if (await send({ targetLocales, options })) setSelected(null)
  }

  return (
    <div className="rr-translator__drawer">
      {notice}
      {/* The notice saying where the translation is written comes before the locales,
          because "Retry" writes too and the notice must precede the first button in the
          tab order. */}
      {status.writesLive ? (
        <Notice id={modeDescription} tone="warning" icon="warning">
          {t('translator:writesLive')}
        </Notice>
      ) : (
        <Notice id={modeDescription} tone="info" icon="info">
          {t('translator:draftNotice')}
        </Notice>
      )}
      <LocaleStates
        locales={status.locales}
        selected={chosen}
        translated={translated}
        busy={busy}
        error={missingLanguage ? t('translator:chooseLanguage') : null}
        onToggle={code => {
          setMissingLanguage(false)
          setSelected(
            chosen.includes(code)
              ? chosen.filter(item => item !== code)
              : [...chosen, code],
          )
        }}
        onRetry={code => void translate([code])}
        retryDescribedBy={modeDescription}
        writesLive={status.writesLive}
      />
      <TranslateOptions
        definitions={TRANSLATE_OPTIONS}
        values={options}
        onChange={(id, value) => setOptions({ ...options, [id]: value })}
      />
      <SubmitFooter
        busy={busy}
        messages={messages}
        describedBy={modeDescription}
        onSubmit={() => {
          if (chosen.length === 0) setMissingLanguage(true)
          else void translate(chosen)
        }}
      />
    </div>
  )
}

export const TranslateDrawer = (props: DrawerProps): ReactElement => (
  <Drawer
    slug={props.slug}
    className="rr-translator-drawer"
    gutter={false}
    Header={<DrawerHeader slug={props.slug} title={props.title} />}
  >
    <DrawerBody {...props} />
  </Drawer>
)
