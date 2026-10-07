'use client'

import type { ReactElement, ReactNode } from 'react'

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'error'

export type NoticeIcon = 'progress' | 'info' | 'success' | 'warning'

export const Spinner = (): ReactElement => (
  <span className="rr-translator__spinner" aria-hidden="true" />
)

const ICON_PATHS: Record<Exclude<NoticeIcon, 'progress'>, ReactElement> = {
  info: (
    <>
      <circle cx="10" cy="10" r="7.25" />
      <path d="M10 9v4.5M10 6.5v.01" />
    </>
  ),
  success: (
    <>
      <circle cx="10" cy="10" r="7.25" />
      <path d="m7 10.25 2 2 4-4.5" />
    </>
  ),
  warning: (
    <>
      <path d="M10 3.25 17.25 16H2.75L10 3.25Z" />
      <path d="M10 8.5v3.5M10 14v.01" />
    </>
  ),
}

const Icon = ({ icon }: { icon: NoticeIcon }): ReactElement =>
  icon === 'progress' ? (
    <Spinner />
  ) : (
    <svg
      className="rr-translator__notice-icon"
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[icon]}
    </svg>
  )

// With `srText`, the visible text is a short label and screen readers read the full
// sentence instead.
export const Notice = ({
  id,
  tone,
  icon,
  action,
  srText,
  children,
}: {
  id?: string
  tone: Tone
  icon: NoticeIcon
  action?: ReactNode
  srText?: string
  children: ReactNode
}): ReactElement => (
  <div id={id} className="rr-translator__notice" data-tone={tone}>
    <Icon icon={icon} />
    <p className="rr-translator__notice-text">
      {srText ? (
        <>
          <span aria-hidden="true">{children}</span>
          <span className="rr-translator__sr-only">{srText}</span>
        </>
      ) : (
        children
      )}
    </p>
    {action}
  </div>
)
