'use client'

import type { ReactElement } from 'react'

import type { Message, Translate } from './messages.js'

// Vive en la barra y no en el drawer para anunciar el progreso y el resultado aunque el
// drawer esté cerrado. Siempre montada y solo cambian sus hijos: los lectores de pantalla
// no anuncian una región viva que aparece ya con contenido.
export const TranslateStatus = ({
  messages,
  t,
}: {
  messages: Message[]
  t: Translate
}): ReactElement => (
  <div role="status" className="rr-translator__sr-only">
    {messages.map(message => (
      <p key={message.key}>{t(message.key as never, message.vars)}</p>
    ))}
  </div>
)
