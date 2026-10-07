'use client'

import type { ReactElement } from 'react'

import { MessageList } from './MessageList.js'
import type { Message } from './messages.js'

// This live region sits in the bar, not in the drawer, so progress and results are
// announced even while the drawer is closed. It stays mounted and only its children change,
// because screen readers do not announce a live region that appears already filled.
//
// While the drawer is open its summary does the announcing (`silenced`). This region then
// switches to `aria-live="off"` but keeps its content, so nothing is announced again when
// the drawer closes.
export const TranslateStatus = ({
  messages,
  silenced,
}: {
  messages: Message[]
  silenced: boolean
}): ReactElement => (
  <div
    role="status"
    aria-live={silenced ? 'off' : 'polite'}
    className="rr-translator__sr-only"
  >
    <MessageList messages={messages} />
  </div>
)
