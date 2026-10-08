// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { TranslateControl } from '../../../src/ui/TranslateControl.js'
import {
  reloadPage,
  locale,
  documentInfo,
  editDepth,
  row,
  status,
  staleEn,
  respond,
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

describe('TranslateControl: in a locale translated from another one', () => {
  it('shows the stale notice linking to the language it was translated from, next to the button', async () => {
    locale.code = 'en'
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          respond(status([row({ locale: 'ca' }), { ...staleEn, sourceLocale: 'ca' }])),
        ),
    )
    render(<TranslateControl />)

    expect(
      await screen.findByText('translator:staleNotice{"source":"Català"}'),
    ).toBeTruthy()
    expect(screen.getByText('translator:staleShort').getAttribute('aria-hidden')).toBe(
      'true',
    )
    expect(
      screen
        .getByRole('link', { name: 'translator:goToSource{"source":"Català"}' })
        .getAttribute('href'),
    ).toBe('?locale=ca')
    expect(screen.getByRole('button', { name: 'translator:translate' })).toBeTruthy()
  })

  it('offers to translate from the open language towards the other ones', async () => {
    locale.code = 'ca'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(status())))
    render(<TranslateControl />)

    await openDrawer()

    expect(
      screen.getByRole('dialog', { name: 'translator:drawerTitle{"source":"Català"}' }),
    ).toBeTruthy()
    const boxes = within(drawer()).getAllByRole('checkbox', {
      name: /^(Español|English)$/,
    })
    expect(boxes.map(box => box.closest('li')?.textContent?.slice(0, 7))).toEqual([
      'Español',
      'English',
    ])
    expect(within(drawer()).queryByRole('checkbox', { name: 'Català' })).toBeNull()
    expect(
      within(drawer()).getByRole('button', { name: 'translator:submit' }),
    ).toBeTruthy()
  })

  it('posts the open language as the source', async () => {
    locale.code = 'ca'
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(status()))
      .mockResolvedValueOnce(respond(status()))
      .mockResolvedValueOnce(respond({ queued: ['es', 'en'] }, 202))
      .mockResolvedValue(respond(status()))
    vi.stubGlobal('fetch', fetchMock)
    render(<TranslateControl />)

    await openDrawer()
    await submit()

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
    expect(postBody(fetchMock.mock.calls[2])).toEqual({
      collection: 'events',
      id: 'e1',
      sourceLocale: 'ca',
      targetLocales: ['es', 'en'],
      overwriteEdited: false,
    })
  })

  it('tells each language which one it was translated from', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.parse('2026-10-05T12:00:00Z') })
    locale.code = 'en'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        respond(
          status([
            row({
              locale: 'es',
              state: 'done',
              sourceLocale: 'ca',
              translatedAt: '2026-10-05T10:00:00Z',
            }),
            row({
              locale: 'ca',
              state: 'done',
              sourceLocale: 'es',
              stale: true,
              changed: 2,
              translatedAt: '2026-10-05T11:00:00Z',
            }),
            row({ locale: 'en' }),
          ]),
        ),
      ),
    )
    render(<TranslateControl />)

    await openDrawer(/translator:translate/)

    const spanishRow = within(drawer())
      .getByRole('checkbox', { name: 'Español' })
      .closest('li')!
    expect(spanishRow.textContent).toContain(
      'translator:translatedFrom{"source":"Català","when":"hace 2 horas"}',
    )
    const catalanRow = within(drawer())
      .getByRole('checkbox', { name: 'Català' })
      .closest('li')!
    expect(catalanRow.textContent).toContain(
      'translator:changedCount{"count":2,"source":"Español"}',
    )
    expect(catalanRow.textContent).toContain(
      'translator:translatedFrom{"source":"Español","when":"hace 1 hora"}',
    )
  })

  it('counts the stale and failed languages other than the open one on the button', async () => {
    locale.code = 'en'
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
    expect(button.textContent).toContain('translator:attentionFailed{"count":1}')
    expect(button.textContent).not.toContain('translator:attentionStale')
  })

  it('announces the end of a translation of another language without asking to reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    locale.code = 'ca'
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(respond(status([row({ locale: 'en', state: 'running' })])))
        .mockResolvedValue(
          respond(status([row({ locale: 'en', state: 'done', translatedAt: 'x' })])),
        ),
    )
    render(<TranslateControl />)

    await screen.findByRole('button', { name: 'translator:inProgress' })
    await waitFor(() =>
      expect(liveRegion().textContent).toContain('translator:inProgress'),
    )
    expect(screen.queryByText(/translator:translatingThisLocale/)).toBeNull()
    await advance()

    expect(liveRegion().textContent).toContain('translator:finished')
    expect(screen.queryByRole('button', { name: 'translator:reload' })).toBeNull()
  })

  it('warns that the current language is being translated, then offers to reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    locale.code = 'ca'
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          respond(
            status([row({ locale: 'ca', state: 'running' }), row({ locale: 'en' })]),
          ),
        )
        .mockResolvedValueOnce(
          respond(
            status([row({ locale: 'ca', state: 'running' }), row({ locale: 'en' })]),
          ),
        )
        .mockResolvedValue(
          respond(
            status([
              row({ locale: 'ca', state: 'done', translatedAt: 'x' }),
              row({ locale: 'en' }),
            ]),
          ),
        ),
    )
    render(<TranslateControl />)

    expect(await screen.findByText('translator:translatingThisLocale')).toBeTruthy()
    expect(screen.getByText('translator:translatingShort')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'translator:reload' })).toBeNull()
    await openDrawer('translator:inProgress')
    expect(
      within(drawer())
        .getByText('translator:translatingThisLocale')
        .closest('[aria-hidden]'),
    ).toBeNull()
    await userEvent.click(within(drawer()).getByRole('button', { name: 'general:close' }))
    await advance()

    expect(screen.queryByText('translator:translatingThisLocale')).toBeNull()
    expect(screen.getByText('translator:readyThisLocale')).toBeTruthy()
    const ready = screen.getByText('translator:readyShort')
    expect(ready.closest('[data-tone]')?.getAttribute('data-tone')).toBe('warning')
    expect(liveRegion().textContent).toContain('translator:finished')
    await userEvent.click(screen.getByRole('button', { name: 'translator:reload' }))
    expect(reloadPage).toHaveBeenCalledTimes(1)
  })

  it('reports the error when the current language fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    locale.code = 'ca'
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(respond(status([row({ locale: 'ca', state: 'queued' })])))
        .mockResolvedValue(
          respond(status([row({ locale: 'ca', state: 'failed', error: 'quota' })])),
        ),
    )
    render(<TranslateControl />)

    await screen.findByText('translator:translatingThisLocale')
    await advance()

    expect(
      screen.getAllByText('translator:failed{"error":"quota"}').length,
    ).toBeGreaterThan(0)
    expect(screen.getByText('translator:failedShort')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'translator:reload' })).toBeNull()
  })
})

describe('TranslateControl: in a nested document drawer', () => {
  it('links "Review" to the document itself in a new tab', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    editDepth.value = 2
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(respond(status()))
        .mockResolvedValueOnce(respond(status()))
        .mockResolvedValueOnce(respond({ queued: ['ca'] }, 202))
        .mockResolvedValue(respond(status([doneCa, row({ locale: 'en' })]))),
    )
    render(<TranslateControl />)
    await openDrawer()
    await userEvent.click(within(drawer()).getByRole('checkbox', { name: 'English' }))
    await submit()

    const review = await within(drawer()).findByRole('link', {
      name: 'translator:review Català translator:opensInNewTab',
    })
    expect(review.getAttribute('href')).toBe('/admin/collections/events/e1?locale=ca')
    expect(review.getAttribute('target')).toBe('_blank')
    expect(review.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('links the stale notice of a global to the global in a new tab', async () => {
    editDepth.value = 2
    locale.code = 'en'
    documentInfo.id = undefined
    documentInfo.collectionSlug = undefined
    documentInfo.globalSlug = 'footer'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(status([staleEn]))))
    render(<TranslateControl />)

    const link = await screen.findByRole('link', { name: /translator:goToSource/ })
    expect(link.getAttribute('href')).toBe('/admin/globals/footer?locale=es')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.textContent).toContain('translator:opensInNewTab')
  })

  it('keeps the links on the page itself outside a nested drawer', async () => {
    locale.code = 'en'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(status([staleEn]))))
    render(<TranslateControl />)

    const link = await screen.findByRole('link', { name: /translator:goToSource/ })
    expect(link.getAttribute('href')).toBe('?locale=es')
    expect(link.getAttribute('target')).toBeNull()
  })

  it('asks to reopen the document instead of reloading the parent page', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    editDepth.value = 2
    locale.code = 'ca'
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(respond(status([row({ locale: 'ca', state: 'running' })])))
        .mockResolvedValue(respond(status([doneCa]))),
    )
    render(<TranslateControl />)
    await screen.findByText('translator:translatingShort')

    await advance()

    expect(screen.getByText('translator:readyNestedShort')).toBeTruthy()
    expect(screen.getByText('translator:readyNestedThisLocale')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'translator:reload' })).toBeNull()
  })
})
