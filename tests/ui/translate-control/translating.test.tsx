// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { TranslateControl } from '../../../src/ui/TranslateControl.js'
import {
  locale,
  documentInfo,
  row,
  status,
  checked,
  respond,
  deferred,
  settle,
  drawer,
  openDrawer,
  submit,
  liveRegion,
  postBody,
  advance,
  doneCa,
} from './helpers.js'

vi.mock('@payloadcms/ui', async () => (await import('./helpers.js')).payloadUiMock())
vi.mock('../../../src/ui/reloadPage.js', async () => ({
  reloadPage: (await import('./helpers.js')).reloadPage,
}))

describe('TranslateControl: translating', () => {
  it('posts the selected languages and reports progress until they are ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(status()))
      .mockResolvedValueOnce(respond(status()))
      .mockResolvedValueOnce(respond({ queued: ['ca'] }, 202))
      .mockResolvedValueOnce(respond(status([row({ locale: 'ca', state: 'running' })])))
      .mockResolvedValue(
        respond(
          status([
            row({
              locale: 'ca',
              state: 'done',
              translatedAt: new Date().toISOString(),
              kept: 2,
            }),
            row({ locale: 'en' }),
          ]),
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    render(<TranslateControl />)

    await openDrawer()
    await userEvent.click(within(drawer()).getByRole('checkbox', { name: 'English' }))
    await submit()

    const [url, init] = fetchMock.mock.calls[2]!
    expect(url).toBe('/api/translator/translate')
    expect(init.method).toBe('POST')
    expect(postBody(fetchMock.mock.calls[2])).toEqual({
      collection: 'events',
      id: 'e1',
      sourceLocale: 'es',
      targetLocales: ['ca'],
      overwriteEdited: false,
    })
    await waitFor(() =>
      expect(liveRegion().textContent).toContain('translator:inProgress'),
    )
    expect(screen.getByRole('button', { name: 'translator:inProgress' })).toBeTruthy()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000)
    })
    await waitFor(() => expect(liveRegion().textContent).toContain('translator:done'))
    expect(liveRegion().textContent).toContain('translator:kept{"count":2}')
    const catalanRow = within(drawer())
      .getByRole('checkbox', { name: 'Català' })
      .closest('li')!
    expect(catalanRow.textContent).toContain('translator:stateDraftReady')
    expect(
      within(catalanRow)
        .getByRole('link', { name: 'translator:review Català' })
        .getAttribute('href'),
    ).toBe('?locale=ca')
    expect(drawer().textContent).toContain('translator:done')
  })

  it('keeps polling and announcing after the drawer is closed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(status()))
      .mockResolvedValueOnce(respond(status()))
      .mockResolvedValueOnce(respond({ queued: ['ca'] }, 202))
      .mockResolvedValueOnce(respond(status([row({ locale: 'ca', state: 'running' })])))
      .mockResolvedValue(
        respond(status([row({ locale: 'ca', state: 'done', translatedAt: 'x' })])),
      )
    vi.stubGlobal('fetch', fetchMock)
    render(<TranslateControl />)

    await openDrawer()
    await userEvent.click(within(drawer()).getByRole('checkbox', { name: 'English' }))
    await submit()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
    await userEvent.click(within(drawer()).getByRole('button', { name: 'general:close' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(liveRegion().textContent).toContain('translator:done')
    expect(screen.getByRole('button', { name: 'translator:translate' })).toBeTruthy()
  })

  it.each([
    ['busy', respond({ error: 'busy', busy: ['ca'] }, 409)],
    ['notConfigured', respond({ error: 'not-configured' }, 503)],
    ['forbidden', respond({ error: 'forbidden' }, 403)],
    ['notFound', respond({ error: 'not-found' }, 404)],
    ['badRequest', respond({ error: 'bad-request' }, 400)],
    ['requestFailed', respond({ error: 'failed' }, 500)],
    ['requestFailed', respond({ error: 'boom' }, 500)],
    ['requestFailed', respond({ error: 'down' }, 502)],
  ])('shows the %s message when the request is refused', async (key, response) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(respond(status()))
        .mockResolvedValueOnce(respond(status()))
        .mockResolvedValueOnce(response)
        .mockResolvedValue(respond(status())),
    )
    render(<TranslateControl />)

    await openDrawer()
    await submit()

    await waitFor(() => expect(liveRegion().textContent).toContain(`translator:${key}`))
    expect(drawer().textContent).toContain(`translator:${key}`)
  })

  it('keeps the manually selected locale after a busy refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          respond(status([doneCa, row({ locale: 'en', state: 'done' })])),
        )
        .mockResolvedValueOnce(
          respond(status([doneCa, row({ locale: 'en', state: 'done' })])),
        )
        .mockResolvedValueOnce(
          respond(status([doneCa, row({ locale: 'en', state: 'done' })])),
        )
        .mockResolvedValueOnce(respond({ error: 'busy' }, 409))
        .mockResolvedValue(respond(status())),
    )
    render(<TranslateControl />)
    await openDrawer()
    const english = within(drawer()).getByRole('checkbox', { name: 'English' })
    await userEvent.click(english)
    await submit()
    await waitFor(() => expect(drawer().textContent).toContain('translator:busy'))
    expect(checked(english)).toBe(true)
  })

  it('clears a ready notice when the document identity changes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    locale.code = 'ca'
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(status([row({ locale: 'ca', state: 'running' })])))
      .mockResolvedValueOnce(
        respond(status([row({ locale: 'ca', state: 'done', translatedAt: 'x' })])),
      )
      .mockResolvedValue(
        respond(status([row({ locale: 'ca', state: 'done', translatedAt: 'x' })])),
      )
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<TranslateControl />)
    await screen.findByText('translator:translatingThisLocale')
    await advance()
    expect(await screen.findByText('translator:readyShort')).toBeTruthy()
    documentInfo.id = 'e2'
    view.rerender(<TranslateControl />)
    await settle()
    expect(screen.queryByText('translator:readyShort')).toBeNull()
  })

  it('shows a generic error when the translate request is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(respond(status()))
        .mockResolvedValueOnce(respond(status()))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValue(respond(status())),
    )
    render(<TranslateControl />)

    await openDrawer()
    await submit()

    await waitFor(() =>
      expect(liveRegion().textContent).toContain('translator:requestFailed'),
    )
  })

  it('sends a numeric document id as a string', async () => {
    documentInfo.id = 42
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(status()))
      .mockResolvedValueOnce(respond(status()))
      .mockResolvedValueOnce(respond({ queued: ['ca', 'en'] }, 202))
      .mockResolvedValue(respond(status()))
    vi.stubGlobal('fetch', fetchMock)
    render(<TranslateControl />)

    await openDrawer()
    await submit()

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
    expect(postBody(fetchMock.mock.calls[2]).id).toBe('42')
  })

  it('keeps the submit button focusable but inert while the request is in flight', async () => {
    const post = deferred()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(status()))
      .mockResolvedValueOnce(respond(status()))
      .mockReturnValueOnce(post.promise)
      .mockResolvedValue(respond(status()))
    vi.stubGlobal('fetch', fetchMock)
    render(<TranslateControl />)

    await openDrawer()
    const button = within(drawer()).getByRole('button', { name: 'translator:submit' })
    await userEvent.click(button)

    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect((button as HTMLButtonElement).disabled).toBe(false)
    expect(document.activeElement).toBe(button)
    await userEvent.click(button)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    await act(async () => {
      post.resolve(respond({ queued: ['ca', 'en'] }, 202))
    })
  })

  it('keeps the submit button primary and warns inline when no language is checked', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(status()))
    vi.stubGlobal('fetch', fetchMock)
    render(<TranslateControl />)

    await openDrawer()
    await userEvent.click(within(drawer()).getByRole('checkbox', { name: 'Català' }))
    await userEvent.click(within(drawer()).getByRole('checkbox', { name: 'English' }))
    const button = within(drawer()).getByRole('button', { name: 'translator:submit' })
    expect(button.getAttribute('aria-disabled')).toBeNull()
    expect(button.className).not.toContain('btn--disabled')
    expect(within(drawer()).queryByText('translator:chooseLanguage')).toBeNull()
    await userEvent.click(button)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const alert = within(drawer()).getByRole('alert')
    expect(alert.textContent).toBe('translator:chooseLanguage')
    const group = within(drawer()).getByRole('group', { name: 'translator:languages' })
    expect(group.getAttribute('aria-describedby')).toBe(alert.id)

    await userEvent.click(within(drawer()).getByRole('checkbox', { name: 'English' }))
    expect(within(drawer()).getByRole('alert').textContent).toBe('')
    expect(group.getAttribute('aria-describedby')).toBeNull()
  })

  it('explains why the submit button is inactive while a translation runs', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(respond(status([row({ locale: 'ca', state: 'running' })]))),
    )
    render(<TranslateControl />)

    await openDrawer('translator:inProgress')

    const button = within(drawer()).getByRole('button', { name: 'translator:submit' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    const descriptions = button
      .getAttribute('aria-describedby')!
      .split(' ')
      .map(id => document.getElementById(id)?.textContent)
    expect(descriptions).toContain('translator:busyHint')
  })

  it('keeps the last status and keeps polling after a failed poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(status()))
      .mockResolvedValueOnce(respond(status()))
      .mockResolvedValueOnce(respond({ queued: ['ca'] }, 202))
      .mockResolvedValueOnce(respond(status([row({ locale: 'ca', state: 'running' })])))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(respond({ error: 'down' }, 502))
      .mockResolvedValue(
        respond(status([row({ locale: 'ca', state: 'done', translatedAt: 'x' })])),
      )
    vi.stubGlobal('fetch', fetchMock)
    render(<TranslateControl />)

    await openDrawer()
    await userEvent.click(within(drawer()).getByRole('checkbox', { name: 'English' }))
    await submit()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))

    for (const calls of [5, 6]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000)
      })
      expect(fetchMock).toHaveBeenCalledTimes(calls)
      expect(screen.getByRole('button', { name: 'translator:inProgress' })).toBeTruthy()
      expect(liveRegion().textContent).toContain('translator:inProgress')
    }

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(7)
    expect(liveRegion().textContent).toContain('translator:done')
  })

  it('announces progress, not a stale completion, right after the request is accepted', async () => {
    const refresh = deferred()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(respond(status()))
        .mockResolvedValueOnce(respond(status()))
        .mockResolvedValueOnce(respond({ queued: ['ca', 'en'] }, 202))
        .mockReturnValueOnce(refresh.promise)
        .mockResolvedValue(respond(status())),
    )
    render(<TranslateControl />)

    await openDrawer()
    await submit()

    await waitFor(() =>
      expect(liveRegion().textContent).toContain('translator:inProgress'),
    )
    expect(liveRegion().textContent).not.toContain('translator:done')
    expect(screen.queryByRole('link', { name: /translator:review/ })).toBeNull()

    await act(async () => {
      refresh.resolve(respond({ error: 'down' }, 502))
    })
  })

  it('ignores a refresh from the opening that lands after the request is accepted', async () => {
    const opening = deferred()
    const afterSubmit = deferred()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(respond(status()))
        .mockReturnValueOnce(opening.promise)
        .mockResolvedValueOnce(respond({ queued: ['ca', 'en'] }, 202))
        .mockReturnValueOnce(afterSubmit.promise)
        .mockResolvedValue(respond(status())),
    )
    render(<TranslateControl />)

    await openDrawer()
    await submit()
    await act(async () => {
      opening.resolve(respond(status()))
    })

    expect(liveRegion().textContent).toContain('translator:inProgress')
    expect(liveRegion().textContent).not.toContain('translator:done')

    await act(async () => {
      afterSubmit.resolve(respond({ error: 'down' }, 502))
    })
  })

  it('keeps polling until done when the refresh after the request fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(status()))
      .mockResolvedValueOnce(respond(status()))
      .mockResolvedValueOnce(respond({ queued: ['ca'] }, 202))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(
        respond(status([row({ locale: 'ca', state: 'done', translatedAt: 'x' })])),
      )
    vi.stubGlobal('fetch', fetchMock)
    render(<TranslateControl />)

    await openDrawer()
    await userEvent.click(within(drawer()).getByRole('checkbox', { name: 'English' }))
    await submit()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
    expect(liveRegion().textContent).toContain('translator:inProgress')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(liveRegion().textContent).toContain('translator:done')
  })

  it('keeps "Review" inert until no requested language is in progress', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(status()))
      .mockResolvedValueOnce(respond(status()))
      .mockResolvedValueOnce(respond({ queued: ['ca', 'en'] }, 202))
      .mockResolvedValueOnce(
        respond(
          status([
            row({ locale: 'ca', state: 'running' }),
            row({ locale: 'en', state: 'queued' }),
          ]),
        ),
      )
      .mockResolvedValueOnce(
        respond(
          status([
            row({ locale: 'ca', state: 'done', translatedAt: 'x' }),
            row({ locale: 'en', state: 'running' }),
          ]),
        ),
      )
      .mockResolvedValue(
        respond(
          status([
            row({ locale: 'ca', state: 'done', translatedAt: 'x' }),
            row({ locale: 'en', state: 'done', translatedAt: 'x' }),
          ]),
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    render(<TranslateControl />)

    await openDrawer()
    await submit()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })

    const catalanRow = within(drawer())
      .getByRole('checkbox', { name: 'Català' })
      .closest('li')!
    expect(catalanRow.textContent).toContain('translator:stateDraftReady')
    const review = within(catalanRow).getByRole('link', { name: /translator:review/ })
    expect(review.getAttribute('aria-disabled')).toBe('true')
    expect(review.className).toContain('btn--disabled')
    const navigation = new MouseEvent('click', { bubbles: true, cancelable: true })
    review.dispatchEvent(navigation)
    expect(navigation.defaultPrevented).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    const reviews = within(drawer()).getAllByRole('link', { name: /translator:review/ })
    expect(reviews).toHaveLength(2)
    for (const link of reviews) expect(link.getAttribute('aria-disabled')).toBeNull()
  })

  it('keeps "Retry" inert while something is in progress', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        respond(
          status([
            row({ locale: 'ca', state: 'failed', error: 'boom' }),
            row({ locale: 'en', state: 'running' }),
          ]),
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    render(<TranslateControl />)

    await openDrawer('translator:inProgress')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const retry = within(drawer()).getByRole('button', {
      name: 'translator:retry Català',
    })
    expect(retry.getAttribute('aria-disabled')).toBe('true')
    await userEvent.click(retry)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(document.activeElement).toBe(retry)
  })

  it('announces a failure with the error of the failed language', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(status()))
      .mockResolvedValueOnce(respond(status()))
      .mockResolvedValueOnce(respond({ queued: ['ca'] }, 202))
      .mockResolvedValue(
        respond(status([row({ locale: 'ca', state: 'failed', error: 'quota' })])),
      )
    vi.stubGlobal('fetch', fetchMock)
    render(<TranslateControl />)

    await openDrawer()
    await userEvent.click(within(drawer()).getByRole('checkbox', { name: 'English' }))
    await submit()

    await waitFor(() =>
      expect(liveRegion().textContent).toContain('translator:failed{"error":"quota"}'),
    )
  })
})
