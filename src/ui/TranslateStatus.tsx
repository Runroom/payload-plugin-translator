'use client'

import type { ReactElement } from 'react'

import type { Message, Translate } from './messages.js'

// Vive en la barra y no en el drawer para anunciar el progreso y el resultado aunque el
// drawer esté cerrado. Siempre montada y solo cambian sus hijos: los lectores de pantalla
// no anuncian una región viva que aparece ya con contenido.
//
// Con el drawer abierto anuncia su resumen (`silenced`): esta se calla con
// `aria-live="off"` pero conserva el contenido, para no volver a anunciarlo al cerrar.
export const TranslateStatus = ({
  messages,
  silenced,
  t,
}: {
  messages: Message[]
  silenced: boolean
  t: Translate
}): ReactElement => (
  <div
    role="status"
    aria-live={silenced ? 'off' : 'polite'}
    className="rr-translator__sr-only"
  >
    {messages.map(message => (
      <p key={message.key}>{t(message.key as never, message.vars)}</p>
    ))}
  </div>
)
