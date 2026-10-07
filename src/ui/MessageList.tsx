'use client'

import type { ReactElement } from 'react'

import { useTranslator } from './TranslatorContext.js'
import type { Message } from './messages.js'

export const MessageList = ({ messages }: { messages: Message[] }): ReactElement => {
  const { t } = useTranslator()
  return (
    <>
      {messages.map(message => (
        <p key={message.key}>{t(message.key, message.vars)}</p>
      ))}
    </>
  )
}
