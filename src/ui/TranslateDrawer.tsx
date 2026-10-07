'use client'

import { Button, Drawer, useModal, XIcon } from '@payloadcms/ui'
import type { ReactElement, ReactNode } from 'react'
import { useEffect, useId, useRef, useState } from 'react'

import type { LocaleStatus, StatusResponse } from '../shared/api.js'
import { isUpToDate, LocaleStates } from './LocaleStates.js'
import { Notice } from './Notice.js'
import { TranslateOptions } from './TranslateOptions.js'
import type { LocaleLink } from './localeLink.js'
import type { Message, Translate } from './messages.js'
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
  labelOf: (code: string) => string
  sourceLabelOf: (item: LocaleStatus) => string
  language: string
  linkOf: (locale: string) => LocaleLink | null
  refresh: () => Promise<void>
  send: SendTranslation
  t: Translate
}

// Payload's `Drawer` leaves the dialog with an `aria-label` equal to the slug, which is
// what the screen reader would announce; it is pointed at the visible title instead.
const DrawerHeader = ({
  slug,
  title,
  t,
}: Pick<DrawerProps, 'slug' | 'title' | 't'>): ReactElement => {
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

// The bar's live region is outside the `<dialog aria-modal>` and some screen readers
// announce nothing outside the modal: while the drawer is open, this one announces.
const Summary = ({ messages, t }: Pick<DrawerProps, 'messages' | 't'>): ReactElement => (
  <div role="status" className="rr-translator__summary">
    {messages.map(message => (
      <p key={message.key}>{t(message.key, message.vars)}</p>
    ))}
  </div>
)

// Always with the primary look: a grey button with no locales checked looked broken. It only
// looks inactive with a translation in progress, and then it says why. `aria-disabled` and
// not `disabled`: the pressed button keeps the focus inside the drawer while sending.
const SubmitFooter = ({
  busy,
  messages,
  describedBy,
  onSubmit,
  t,
}: Pick<DrawerProps, 'busy' | 'messages' | 't'> & {
  describedBy: string
  onSubmit: () => void
}): ReactElement => {
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
        <Summary messages={messages} t={t} />
      </div>
    </div>
  )
}

// Mounted only while the drawer is open: the selection and the options start from scratch
// every time, and the status is fetched again in case the source changed without a reload.
const DrawerBody = ({
  status,
  translated,
  busy,
  notice,
  messages,
  labelOf,
  sourceLabelOf,
  language,
  linkOf,
  refresh,
  send,
  t,
}: DrawerProps): ReactElement => {
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
      {/* Where the translation ends up, before the locales: "Retry" writes too, and in the
          tab order the notice has to come before the first button. */}
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
        labelOf={labelOf}
        sourceLabelOf={sourceLabelOf}
        selected={chosen}
        translated={translated}
        busy={busy}
        error={missingLanguage ? t('translator:chooseLanguage') : null}
        language={language}
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
        linkOf={linkOf}
        t={t}
      />
      <TranslateOptions
        definitions={TRANSLATE_OPTIONS}
        values={options}
        onChange={(id, value) => setOptions({ ...options, [id]: value })}
        t={t}
      />
      <SubmitFooter
        busy={busy}
        messages={messages}
        describedBy={modeDescription}
        onSubmit={() => {
          if (chosen.length === 0) setMissingLanguage(true)
          else void translate(chosen)
        }}
        t={t}
      />
    </div>
  )
}

export const TranslateDrawer = (props: DrawerProps): ReactElement => (
  <Drawer
    slug={props.slug}
    className="rr-translator-drawer"
    gutter={false}
    Header={<DrawerHeader slug={props.slug} title={props.title} t={props.t} />}
  >
    <DrawerBody {...props} />
  </Drawer>
)
