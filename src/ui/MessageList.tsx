'use client'

import type { ReactElement } from 'react'

import type { Message, Translate } from './messages.js'

export const MessageList = ({
  messages,
  t,
}: {
  messages: Message[]
  t: Translate
}): ReactElement => (
  <>
    {messages.map(message => (
      <p key={message.key}>{t(message.key, message.vars)}</p>
    ))}
  </>
)
