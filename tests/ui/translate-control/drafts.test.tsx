// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TranslateControl } from '../../../src/ui/TranslateControl.js'
import {
  locale,
  documentInfo,
  row,
  status,
  respond,
  settle,
  drawer,
  openDrawer,
  submit,
  liveRegion,
  postBody,
  doneCa,
} from './helpers.js'
import type { LocaleFixture } from './helpers.js'

vi.mock('@payloadcms/ui', async () => (await import('./helpers.js')).payloadUiMock())
vi.mock('../../../src/ui/reloadPage.js', async () => ({
  reloadPage: (await import('./helpers.js')).reloadPage,
}))

describe('TranslateControl: globals and content without drafts', () => {
  it('asks for and translates a global by its slug', async () => {
    documentInfo.id = undefined
    documentInfo.collectionSlug = undefined
    documentInfo.globalSlug = 'footer'
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
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      '/api/translator/status?global=footer',
    )
    const body = postBody(fetchMock.mock.calls[2])
    expect(body).toMatchObject({ global: 'footer', targetLocales: ['ca', 'en'] })
    expect(body).not.toHaveProperty('collection')
    expect(body).not.toHaveProperty('id')
  })

  it('warns before translating that content without drafts goes live at once', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(respond({ ...status(), writesLive: true })),
    )
    render(<TranslateControl />)

    await openDrawer()

    const warning = within(drawer()).getByText('translator:writesLive')
    const button = within(drawer()).getByRole('button', { name: 'translator:submit' })
    const notice = warning.closest('[id]')!
    expect(notice.getAttribute('data-tone')).toBe('warning')
    expect(button.getAttribute('aria-describedby')?.split(' ')).toContain(notice.id)
    expect(
      warning.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('puts the live warning before the languages and ties it to every retry button', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        respond({
          ...status([
            row({ locale: 'ca', state: 'failed', error: 'boom' }),
            row({ locale: 'en' }),
          ]),
          writesLive: true,
        }),
      ),
    )
    render(<TranslateControl />)

    await openDrawer(/translator:translate/)

    const notice = within(drawer()).getByText('translator:writesLive').closest('[id]')!
    const retry = within(drawer()).getByRole('button', {
      name: 'translator:retry Català',
    })
    const firstCheckbox = within(drawer()).getAllByRole('checkbox')[0]!
    expect(retry.getAttribute('aria-describedby')?.split(' ')).toContain(notice.id)
    expect(
      notice.compareDocumentPosition(firstCheckbox) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('announces that a translation without drafts is already published', async () => {
    const live = (locales?: LocaleFixture[]): Response =>
      respond({ ...status(locales), writesLive: true })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(live())
      .mockResolvedValueOnce(live())
      .mockResolvedValueOnce(respond({ queued: ['ca', 'en'] }, 202))
      .mockResolvedValue(
        live([
          row({ locale: 'ca', state: 'done', translatedAt: 'x' }),
          row({ locale: 'en', state: 'done', translatedAt: 'x' }),
        ]),
      )
    vi.stubGlobal('fetch', fetchMock)
    render(<TranslateControl />)

    await openDrawer()
    await submit()

    await waitFor(() => expect(liveRegion().textContent).toContain('translator:doneLive'))
  })

  it('tells the submit button the translation stays a draft, not that it goes live', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(respond({ ...status(), writesLive: false })),
    )
    render(<TranslateControl />)

    await openDrawer()

    expect(within(drawer()).queryByText('translator:writesLive')).toBeNull()
    const button = within(drawer()).getByRole('button', { name: 'translator:submit' })
    const description = document.getElementById(button.getAttribute('aria-describedby')!)
    expect(description?.textContent).toBe('translator:draftNotice')
  })
})

describe('TranslateControl: content with drafts', () => {
  it('explains in the drawer that the translation is a draft to review and publish', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        respond({
          ...status([
            row({ locale: 'ca', state: 'failed', error: 'boom' }),
            row({ locale: 'en' }),
          ]),
          writesLive: false,
        }),
      ),
    )
    render(<TranslateControl />)

    await openDrawer(/translator:translate/)

    const notice = within(drawer()).getByText('translator:draftNotice').closest('[id]')!
    expect(notice.getAttribute('data-tone')).toBe('info')
    expect(within(drawer()).queryByText('translator:writesLive')).toBeNull()
    for (const button of [
      within(drawer()).getByRole('button', { name: 'translator:submit' }),
      within(drawer()).getByRole('button', { name: 'translator:retry Català' }),
    ]) {
      expect(button.getAttribute('aria-describedby')?.split(' ')).toContain(notice.id)
    }
    const firstCheckbox = within(drawer()).getAllByRole('checkbox')[0]!
    expect(
      notice.compareDocumentPosition(firstCheckbox) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it.each([
    [false, 'translator:stateDraftReady'],
    [true, 'translator:statePublished'],
  ])(
    'labels a language finished in this visit by where it went (live %s)',
    async (writesLive, key) => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(respond({ ...status(), writesLive }))
        .mockResolvedValueOnce(respond({ ...status(), writesLive }))
        .mockResolvedValueOnce(respond({ queued: ['ca', 'en'] }, 202))
        .mockResolvedValue(
          respond({
            ...status([doneCa, row({ locale: 'en', state: 'done', translatedAt: 'x' })]),
            writesLive,
          }),
        )
      vi.stubGlobal('fetch', fetchMock)
      render(<TranslateControl />)

      await openDrawer()
      await submit()

      const catalanRow = (): HTMLElement =>
        within(drawer()).getByRole('checkbox', { name: 'Català' }).closest('li')!
      await waitFor(() => expect(catalanRow().textContent).toContain(key))
      expect(catalanRow().textContent).not.toContain('translator:stateUpToDate')
    },
  )
})

describe('TranslateControl: drafts in a target locale', () => {
  const renderCa = (overrides: Partial<LocaleFixture> = {}): void => {
    locale.code = 'ca'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        respond({
          ...status([{ ...doneCa, ...overrides }, row({ locale: 'en' })]),
          writesLive: false,
        }),
      ),
    )
    render(<TranslateControl />)
  }

  it('flags an unpublished draft translation', async () => {
    documentInfo.unpublishedVersionCount = 2
    renderCa()

    const short = await screen.findByText('translator:unpublishedShort')
    expect(short.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByText('translator:unpublishedThisLocale')).toBeTruthy()
    expect(short.closest('[data-tone]')?.getAttribute('data-tone')).toBe('info')
  })

  it('flags a document that was never published', async () => {
    documentInfo.hasPublishedDoc = false
    renderCa()

    expect(await screen.findByText('translator:unpublishedShort')).toBeTruthy()
  })

  it('says nothing once the draft is published', async () => {
    renderCa()

    await waitFor(() => expect(fetch).toHaveBeenCalled())
    await settle()
    expect(screen.queryByText('translator:unpublishedShort')).toBeNull()
  })

  // Publishing does not reload the page: Payload sets the counter to 0 in `useDocumentInfo`.
  it('drops the notice when the draft gets published without reloading', async () => {
    documentInfo.unpublishedVersionCount = 1
    locale.code = 'ca'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(respond({ ...status([doneCa]), writesLive: false })),
    )
    const { rerender } = render(<TranslateControl />)
    await screen.findByText('translator:unpublishedShort')

    documentInfo.unpublishedVersionCount = 0
    rerender(<TranslateControl />)

    expect(screen.queryByText('translator:unpublishedShort')).toBeNull()
  })

  it('lets the ready notice with its reload win over the unpublished one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    documentInfo.unpublishedVersionCount = 1
    locale.code = 'ca'
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          respond({
            ...status([row({ locale: 'ca', state: 'running' })]),
            writesLive: false,
          }),
        )
        .mockResolvedValue(respond({ ...status([doneCa]), writesLive: false })),
    )
    render(<TranslateControl />)
    await screen.findByText('translator:translatingShort')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })

    expect(await screen.findByText('translator:readyShort')).toBeTruthy()
    expect(screen.queryByText('translator:unpublishedShort')).toBeNull()
  })

  it('lets the stale notice win over the unpublished one', async () => {
    documentInfo.unpublishedVersionCount = 1
    renderCa({ stale: true, changed: 1 })

    expect(await screen.findByText('translator:staleShort')).toBeTruthy()
    expect(screen.queryByText('translator:unpublishedShort')).toBeNull()
  })

  it('tells the target locale that some fields were left empty', async () => {
    renderCa({ stale: true, missing: 1 })

    expect(await screen.findByText('translator:staleShort')).toBeTruthy()
    expect(screen.getByText(/translator:missingNotice/)).toBeTruthy()
    expect(screen.queryByText(/translator:staleNotice/)).toBeNull()
  })

  it('says nothing about drafts for content without them', async () => {
    documentInfo.unpublishedVersionCount = 1
    locale.code = 'ca'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(respond({ ...status([doneCa]), writesLive: true })),
    )
    render(<TranslateControl />)

    await waitFor(() => expect(fetch).toHaveBeenCalled())
    await settle()
    expect(screen.queryByText('translator:unpublishedShort')).toBeNull()
  })
})

describe('TranslateControl: unpublished drafts per locale', () => {
  const renderCa = (lastPublishedAt: string | null): void => {
    documentInfo.unpublishedVersionCount = 1
    locale.code = 'ca'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        respond({
          ...status([
            row({
              locale: 'ca',
              state: 'done',
              sourceLocale: 'es',
              translatedAt: '2026-10-05T10:00:00.000Z',
            }),
          ]),
          writesLive: false,
          lastPublishedAt,
        }),
      ),
    )
    render(<TranslateControl />)
  }

  it('says nothing in a locale whose translation was published afterwards', async () => {
    renderCa('2026-10-05T11:00:00.000Z')

    await waitFor(() => expect(fetch).toHaveBeenCalled())
    await settle()
    expect(screen.getByRole('button', { name: 'translator:translate' })).toBeTruthy()
    expect(screen.queryByText('translator:unpublishedShort')).toBeNull()
  })

  it('flags a translation newer than the last publication', async () => {
    renderCa('2026-10-05T09:00:00.000Z')

    expect(await screen.findByText('translator:unpublishedShort')).toBeTruthy()
  })
})
