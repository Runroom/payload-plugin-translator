// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { TranslateControl } from '../../../src/ui/TranslateControl.js'
import {
  documentInfo,
  row,
  status,
  staleEn,
  respond,
  deferred,
  settle,
  drawer,
  openDrawer,
  submit,
  liveRegion,
  advance,
  doneCa,
  barRegion,
  abortable,
} from './helpers.js'

vi.mock('@payloadcms/ui', async () => (await import('./helpers.js')).payloadUiMock())
vi.mock('../../../src/ui/reloadPage.js', async () => ({
  reloadPage: (await import('./helpers.js')).reloadPage,
}))

describe('TranslateControl: responses out of order', () => {
  it('does not let a slow refresh overwrite a newer poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const slow = deferred()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(status([row({ locale: 'ca', state: 'running' })])))
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValue(
        respond(status([row({ locale: 'ca', state: 'done', translatedAt: 'x' })])),
      )
    vi.stubGlobal('fetch', fetchMock)
    render(<TranslateControl />)
    await openDrawer('translator:inProgress')
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await advance()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await waitFor(() => expect(liveRegion().textContent).toContain('translator:finished'))

    await act(async () => {
      slow.resolve(respond(status([row({ locale: 'ca', state: 'running' })])))
    })

    expect(liveRegion().textContent).toContain('translator:finished')
    expect(screen.getByRole('button', { name: 'translator:translate' })).toBeTruthy()
    await advance()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('keeps the control while the status of a new document loads', async () => {
    const pending = deferred()
    const fetchMock = vi.fn((url: string, init?: { signal?: AbortSignal }) => {
      if (url.includes('id=e1')) return Promise.resolve(respond(status()))
      if (url.includes('id=e3')) return pending.promise
      return abortable(init?.signal)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { rerender } = render(<TranslateControl />)
    await screen.findByRole('button', { name: 'translator:translate' })

    documentInfo.id = 'e2'
    rerender(<TranslateControl />)
    documentInfo.id = 'e3'
    rerender(<TranslateControl />)
    await settle()

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(screen.getByRole('button', { name: 'translator:translate' })).toBeTruthy()

    await act(async () => {
      pending.resolve(respond(status([staleEn])))
    })
    expect(screen.getByRole('button', { name: /translator:attentionStale/ })).toBeTruthy()
  })
})

describe('TranslateControl: polling that cannot go on', () => {
  it.each([403, 404])('hides the control and stops polling after a %i', async code => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(status([row({ locale: 'ca', state: 'running' })])))
      .mockResolvedValueOnce(respond({ error: 'no' }, code))
      .mockResolvedValue(respond(status([row({ locale: 'ca', state: 'running' })])))
    vi.stubGlobal('fetch', fetchMock)
    const { container } = render(<TranslateControl />)
    await screen.findByRole('button', { name: 'translator:inProgress' })

    await advance()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(container.innerHTML).toBe('')

    await advance(20_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('stops after five failed polls in a row and offers to check again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(status([row({ locale: 'ca', state: 'running' })])))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(respond({ error: 'down' }, 502))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(
        respond(status([row({ locale: 'ca', state: 'done', translatedAt: 'x' })])),
      )
    vi.stubGlobal('fetch', fetchMock)
    render(<TranslateControl />)
    await screen.findByRole('button', { name: 'translator:inProgress' })

    for (let poll = 0; poll < 5; poll += 1) await advance()
    expect(fetchMock).toHaveBeenCalledTimes(6)
    expect(screen.getByText('translator:statusUnavailableShort')).toBeTruthy()
    expect(liveRegion().textContent).toContain('translator:statusUnavailable')

    await advance(20_000)
    expect(fetchMock).toHaveBeenCalledTimes(6)

    await userEvent.click(screen.getByRole('button', { name: 'translator:retry' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7))
    await waitFor(() =>
      expect(screen.queryByText('translator:statusUnavailableShort')).toBeNull(),
    )
    expect(screen.getByRole('button', { name: 'translator:translate' })).toBeTruthy()
  })

  it('counts only failures in a row', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const running = respond(status([row({ locale: 'ca', state: 'running' })]))
    const fetchMock = vi.fn().mockResolvedValueOnce(running)
    for (let round = 0; round < 3; round += 1) {
      fetchMock
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(respond(status([row({ locale: 'ca', state: 'running' })])))
    }
    vi.stubGlobal('fetch', fetchMock)
    render(<TranslateControl />)
    await screen.findByRole('button', { name: 'translator:inProgress' })

    for (let poll = 0; poll < 12; poll += 1) await advance()

    expect(fetchMock).toHaveBeenCalledTimes(13)
    expect(screen.queryByText('translator:statusUnavailableShort')).toBeNull()
  })
})

describe('TranslateControl: which batch the live region sums up', () => {
  it('does not announce the previous batch again after a refused request', async () => {
    const after = status([doneCa, row({ locale: 'en' })])
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(respond(status()))
        .mockResolvedValueOnce(respond(status()))
        .mockResolvedValueOnce(respond({ queued: ['ca'] }, 202))
        .mockResolvedValueOnce(respond(after))
        .mockResolvedValueOnce(respond(after))
        .mockResolvedValueOnce(respond({ error: 'busy', busy: ['en'] }, 409))
        .mockResolvedValue(respond(after)),
    )
    render(<TranslateControl />)
    await openDrawer()
    await userEvent.click(within(drawer()).getByRole('checkbox', { name: 'English' }))
    await submit()
    await waitFor(() => expect(liveRegion().textContent).toContain('translator:done'))
    await userEvent.click(within(drawer()).getByRole('button', { name: 'general:close' }))

    await openDrawer()
    await submit()
    await waitFor(() => expect(liveRegion().textContent).toContain('translator:busy'))
    await userEvent.click(within(drawer()).getByRole('button', { name: 'general:close' }))
    await openDrawer()
    await settle()

    expect(liveRegion().textContent).toBe('')
    expect(barRegion().textContent).toBe('')
  })

  it('sums up a batch launched elsewhere once its own batch is over', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(status()))
      .mockResolvedValueOnce(respond(status()))
      .mockResolvedValueOnce(respond({ queued: ['ca'] }, 202))
      .mockResolvedValueOnce(respond(status([doneCa, row({ locale: 'en' })])))
      .mockResolvedValueOnce(
        respond(status([doneCa, row({ locale: 'en', state: 'running' })])),
      )
      .mockResolvedValue(
        respond(
          status([doneCa, row({ locale: 'en', state: 'done', translatedAt: 'x' })]),
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    render(<TranslateControl />)
    await openDrawer()
    await userEvent.click(within(drawer()).getByRole('checkbox', { name: 'English' }))
    await submit()
    await waitFor(() => expect(liveRegion().textContent).toContain('translator:done'))
    await userEvent.click(within(drawer()).getByRole('button', { name: 'general:close' }))

    await openDrawer()
    await waitFor(() =>
      expect(liveRegion().textContent).toContain('translator:inProgress'),
    )
    await advance()

    expect(liveRegion().textContent).toContain('translator:finished')
  })
})
