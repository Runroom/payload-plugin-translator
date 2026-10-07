'use client'

import type { ReactElement } from 'react'

import { MessageList } from './MessageList.js'
import type { Message, Translate } from './messages.js'

// It lives in the bar and not in the drawer to announce the progress and the result even
// while the drawer is closed. Always mounted and only its children change: screen readers do
// not announce a live region that appears already filled.
//
// With the drawer open, the drawer's summary announces (`silenced`): this one goes quiet
// with `aria-live="off"` but keeps its content, so it is not announced again on close.
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
    <MessageList messages={messages} t={t} />
  </div>
)
