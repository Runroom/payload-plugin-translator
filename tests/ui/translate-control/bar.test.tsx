// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { TranslateControl } from '../../../src/ui/TranslateControl.js'
import { row, status, staleEn, respond, drawer, liveRegion } from './helpers.js'

vi.mock('@payloadcms/ui', async () => (await import('./helpers.js')).payloadUiMock())
vi.mock('../../../src/ui/reloadPage.js', async () => ({
  reloadPage: (await import('./helpers.js')).reloadPage,
}))

describe('TranslateControl: the bar', () => {
  it('shows a small button that announces it opens a dialog', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(status())))
    render(<TranslateControl />)

    const button = await screen.findByRole('button', { name: 'translator:translate' })
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps an empty, visually hidden live region mounted before there is anything to announce', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(status())))
    render(<TranslateControl />)

    await screen.findByRole('button', { name: 'translator:translate' })
    expect(liveRegion().textContent).toBe('')
    expect(liveRegion().classList.contains('rr-translator__sr-only')).toBe(true)
  })

  it('flags out-of-date and failed languages in the accessible name, not only with the dot', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          respond(
            status([row({ locale: 'ca', state: 'failed', error: 'boom' }), staleEn]),
          ),
        ),
    )
    render(<TranslateControl />)

    const button = await screen.findByRole('button', {
      name: /^translator:translate — translator:attention/,
    })
    expect(button.textContent).toContain('translator:attentionStale{"count":1}')
    expect(button.textContent).toContain('translator:attentionFailed{"count":1}')
    expect(button.querySelector('.rr-translator__dot')?.getAttribute('aria-hidden')).toBe(
      'true',
    )
  })

  it('shows no indicator when every language is up to date or untranslated', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          respond(status([row({ locale: 'ca' }), row({ locale: 'en', state: 'done' })])),
        ),
    )
    render(<TranslateControl />)

    const button = await screen.findByRole('button', { name: 'translator:translate' })
    expect(button.querySelector('.rr-translator__dot')).toBeNull()
  })

  it('turns into a progress button that still opens the drawer while a language is in progress', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          respond(status([row({ locale: 'ca', state: 'running' }), staleEn])),
        ),
    )
    render(<TranslateControl />)

    const button = await screen.findByRole('button', { name: 'translator:inProgress' })
    expect(
      button.querySelector('.rr-translator__spinner')?.getAttribute('aria-hidden'),
    ).toBe('true')
    expect(button.querySelector('.rr-translator__dot')).toBeNull()
    await userEvent.click(button)

    expect(drawer()).toBeTruthy()
  })
})
