'use client'

import { Button, Drawer, useModal, XIcon } from '@payloadcms/ui'
import type { ReactElement, ReactNode } from 'react'
import { useEffect, useId, useRef, useState } from 'react'

import type { LocaleStatus, StatusResponse } from '../server/status.js'
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

// El `Drawer` de Payload deja el diálogo con `aria-label` igual al slug, que es lo que
// anunciaría el lector de pantalla; se le apunta al título visible.
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
        aria-label={t('general:close' as never)}
        onClick={() => closeModal(slug)}
      >
        <XIcon />
      </button>
    </div>
  )
}

// La región viva de la barra queda fuera del `<dialog aria-modal>` y hay lectores que no
// anuncian nada fuera del modal: mientras el drawer está abierto, anuncia esta.
const Summary = ({ messages, t }: Pick<DrawerProps, 'messages' | 't'>): ReactElement => (
  <div role="status" className="rr-translator__summary">
    {messages.map(message => (
      <p key={message.key}>{t(message.key as never, message.vars)}</p>
    ))}
  </div>
)

// Siempre con el aspecto primario: un botón gris sin idiomas marcados parecía roto. Solo
// se ve inactivo con una traducción en curso, y entonces dice por qué. `aria-disabled` y
// no `disabled`: el botón pulsado conserva el foco dentro del drawer mientras se envía.
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
        {t('translator:submit' as never)}
      </Button>
      <div className="rr-translator__footer-text">
        {busy ? (
          <p id={hintId} className="rr-translator__busy-hint">
            {t('translator:busyHint' as never)}
          </p>
        ) : null}
        <Summary messages={messages} t={t} />
      </div>
    </div>
  )
}

// Montado solo con el drawer abierto: la selección y las opciones parten de cero cada
// vez, y el estado se trae de nuevo por si el origen cambió sin recargar.
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
    await send({ targetLocales, options })
    setSelected(null)
  }

  return (
    <div className="rr-translator__drawer">
      {notice}
      {/* Dónde queda la traducción, antes de los idiomas: «Reintentar» también escribe, y
          en el orden de tabulación el aviso tiene que llegar antes que el primer botón. */}
      {status.writesLive ? (
        <Notice id={modeDescription} tone="warning" icon="warning">
          {t('translator:writesLive' as never)}
        </Notice>
      ) : (
        <Notice id={modeDescription} tone="info" icon="info">
          {t('translator:draftNotice' as never)}
        </Notice>
      )}
      <LocaleStates
        locales={status.locales}
        labelOf={labelOf}
        sourceLabelOf={sourceLabelOf}
        selected={chosen}
        translated={translated}
        busy={busy}
        error={missingLanguage ? t('translator:chooseLanguage' as never) : null}
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
