// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TranslateControl } from '../../../src/ui/TranslateControl.js'
import { locale, row, status, respond, settle, drawer, openDrawer } from './helpers.js'

vi.mock('@payloadcms/ui', async () => (await import('./helpers.js')).payloadUiMock())
vi.mock('../../../src/ui/reloadPage.js', async () => ({
  reloadPage: (await import('./helpers.js')).reloadPage,
}))

describe('TranslateControl: access and loading', () => {
  it('renders nothing when the status endpoint forbids access', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(respond({ error: 'forbidden' }, 403)),
    )

    const { container } = render(<TranslateControl />)

    await waitFor(() => expect(fetch).toHaveBeenCalled())
    await settle()
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when the status endpoint is not found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond({ error: 'nope' }, 404)))

    const { container } = render(<TranslateControl />)

    await waitFor(() => expect(fetch).toHaveBeenCalled())
    await settle()
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when the translator is disabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(respond({ ...status(), enabled: false })),
    )

    const { container } = render(<TranslateControl />)

    await waitFor(() => expect(fetch).toHaveBeenCalled())
    await settle()
    expect(container.innerHTML).toBe('')
  })

  it('retries the initial load after a server error and shows the control', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond({ error: 'down' }, 502))
      .mockResolvedValue(respond(status()))
    vi.stubGlobal('fetch', fetchMock)
    render(<TranslateControl />)

    await settle()
    expect(screen.queryByRole('button', { name: 'translator:translate' })).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'translator:translate' })).toBeTruthy()
  })

  it('gives up on the initial load after three retries with backoff', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)
    const { container } = render(<TranslateControl />)

    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    for (const [delay, calls] of [
      [2_000, 2],
      [4_000, 3],
      [8_000, 4],
      [60_000, 4],
    ] as const) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay)
      })
      expect(fetchMock).toHaveBeenCalledTimes(calls)
    }
    expect(container.innerHTML).toBe('')
  })

  it.each([403, 404])('does not retry the initial load after a %i', async code => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond({ error: 'no' }, code))
      .mockResolvedValue(respond(status()))
    vi.stubGlobal('fetch', fetchMock)
    const { container } = render(<TranslateControl />)

    await settle()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(container.innerHTML).toBe('')
  })
})

describe('TranslateControl: open locale outside the entity', () => {
  it('renders nothing in a locale the entity is not translated into', async () => {
    locale.code = 'en'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        respond({
          enabled: true,
          writesLive: false,
          lastPublishedAt: null,
          locales: [row({ locale: 'es' }), row({ locale: 'ca', state: 'failed' })],
        }),
      ),
    )

    const { container } = render(<TranslateControl />)

    await waitFor(() => expect(fetch).toHaveBeenCalled())
    await settle()
    expect(container.innerHTML).toBe('')
  })
})

describe('TranslateControl: a failure of the open locale from an earlier visit', () => {
  it.each([
    ['quota', 'translator:failed{"error":"quota"}'],
    [null, 'translator:failedNoReason'],
  ])('reports it on arrival (error %s)', async (error, text) => {
    locale.code = 'ca'
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          respond(
            status([
              row({ locale: 'ca', state: 'failed', error }),
              row({ locale: 'en' }),
            ]),
          ),
        ),
    )
    render(<TranslateControl />)

    const short = await screen.findByText('translator:failedShort')
    expect(short.closest('[data-tone]')?.getAttribute('data-tone')).toBe('error')
    expect(screen.getByText(text)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'translator:translate' })).toBeTruthy()
  })

  it('does not leave a dangling colon in a row that failed without a reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(respond(status([row({ locale: 'ca', state: 'failed' })]))),
    )
    render(<TranslateControl />)

    await openDrawer(/translator:translate/)

    const catalanRow = within(drawer())
      .getByRole('checkbox', { name: 'Català' })
      .closest('li')!
    expect(catalanRow.textContent).toContain('translator:failedNoReason')
    expect(catalanRow.textContent).not.toContain('translator:failed{')
  })
})
