// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { TranslateControl } from '../../../src/ui/TranslateControl.js'
import { TranslateOptions } from '../../../src/ui/TranslateOptions.js'
import { TranslatorProvider } from '../../../src/ui/TranslatorContext.js'
import {
  i18n,
  localization,
  row,
  status,
  staleEn,
  checked,
  respond,
  deferred,
  drawer,
  openDrawer,
  submit,
  postBody,
  barRegion,
} from './helpers.js'

vi.mock('@payloadcms/ui', async () => (await import('./helpers.js')).payloadUiMock())
vi.mock('../../../src/ui/reloadPage.js', async () => ({
  reloadPage: (await import('./helpers.js')).reloadPage,
}))

describe('TranslateControl: the drawer', () => {
  it('opens a drawer named by its title', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(status())))
    render(<TranslateControl />)

    await openDrawer()

    expect(
      screen.getByRole('dialog', { name: 'translator:drawerTitle{"source":"Español"}' }),
    ).toBeTruthy()
    expect(
      screen.getByRole('heading', { name: 'translator:drawerTitle{"source":"Español"}' }),
    ).toBeTruthy()
  })

  it('closes from its close button and keeps the bar control', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(status())))
    render(<TranslateControl />)

    await openDrawer()
    await userEvent.click(within(drawer()).getByRole('button', { name: 'general:close' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'translator:translate' })).toBeTruthy()
  })

  it('checks every language that is not up to date', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          respond(
            status([
              row({ locale: 'ca', state: 'done', translatedAt: '2026-10-05T10:00:00Z' }),
              staleEn,
            ]),
          ),
        ),
    )
    render(<TranslateControl />)

    await openDrawer(/translator:translate/)

    expect(checked(within(drawer()).getByRole('checkbox', { name: 'Català' }))).toBe(
      false,
    )
    expect(checked(within(drawer()).getByRole('checkbox', { name: 'English' }))).toBe(
      true,
    )
  })

  it('describes the state of each language in text', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.parse('2026-10-05T12:00:00Z') })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        respond(
          status([
            row({
              locale: 'ca',
              state: 'done',
              translatedAt: '2026-10-05T10:00:00Z',
              kept: 2,
            }),
            staleEn,
          ]),
        ),
      ),
    )
    render(<TranslateControl />)

    await openDrawer(/translator:translate/)

    const catalan = within(drawer()).getByRole('checkbox', { name: 'Català' })
    expect(catalan.getAttribute('aria-describedby')).toBeTruthy()
    const catalanRow = catalan.closest('li')!
    expect(catalanRow.textContent).toContain('translator:stateUpToDate')
    expect(catalanRow.textContent).toContain(
      'translator:translatedFrom{"source":"Español","when":"hace 2 horas"}',
    )
    expect(catalanRow.textContent).toContain('translator:keptCount{"count":2}')
    const description = catalan
      .getAttribute('aria-describedby')!
      .split(' ')
      .map(id => document.getElementById(id)?.textContent)
      .join(' ')
    expect(description).toContain('translator:stateUpToDate')
    expect(description).toContain('translator:keptCount{"count":2}')

    const englishRow = within(drawer())
      .getByRole('checkbox', { name: 'English' })
      .closest('li')!
    expect(englishRow.textContent).toContain('translator:stateStale')
    expect(englishRow.textContent).toContain(
      'translator:changedCount{"count":3,"source":"Español"}',
    )
    expect(englishRow.textContent).not.toContain('translator:keptCount')
  })

  it('explains a stale row whose only problem is an emptied field', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          respond(
            status([
              row({ locale: 'ca' }),
              row({ locale: 'en', state: 'done', stale: true, missing: 2 }),
            ]),
          ),
        ),
    )
    render(<TranslateControl />)
    await openDrawer(/translator:translate/)

    const englishRow = within(drawer())
      .getByRole('checkbox', { name: 'English' })
      .closest('li')!
    expect(englishRow.textContent).toContain('translator:stateStale')
    expect(englishRow.textContent).toContain('translator:missingCount{"count":2}')
    expect(englishRow.textContent).not.toContain('translator:changedCount')
  })

  it('labels every state pill with text, not only colour', async () => {
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

    await openDrawer(/translator:translate/)

    const pills = [...drawer().querySelectorAll('.rr-translator__pill')]
    expect(pills.map(pill => pill.textContent)).toEqual([
      'translator:stateFailed',
      'translator:stateStale',
    ])
    expect(pills.map(pill => pill.getAttribute('data-tone'))).toEqual([
      'error',
      'warning',
    ])
  })

  it('formats the relative time in the admin language', async () => {
    i18n.language = 'en'
    vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.parse('2026-10-05T12:00:00Z') })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          respond(
            status([
              row({ locale: 'ca', state: 'done', translatedAt: '2026-10-04T12:00:00Z' }),
            ]),
          ),
        ),
    )
    render(<TranslateControl />)

    await openDrawer()

    expect(drawer().textContent).toContain(
      'translator:translatedFrom{"source":"Español","when":"yesterday"}',
    )
  })

  it('shows the error of a failed language and retries only that one', async () => {
    const failed = status([
      row({ locale: 'ca', state: 'failed', error: 'boom' }),
      row({ locale: 'en' }),
    ])
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(failed))
      .mockResolvedValueOnce(respond(failed))
      .mockResolvedValueOnce(respond({ queued: ['ca'] }, 202))
      .mockResolvedValue(respond(failed))
    vi.stubGlobal('fetch', fetchMock)
    render(<TranslateControl />)

    await openDrawer(/translator:translate/)
    const catalanRow = within(drawer())
      .getByRole('checkbox', { name: 'Català' })
      .closest('li')!
    expect(catalanRow.textContent).toContain('translator:stateFailed')
    expect(catalanRow.textContent).toContain('translator:failed{"error":"boom"}')

    await userEvent.click(
      within(catalanRow).getByRole('button', { name: 'translator:retry Català' }),
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
    const [url] = fetchMock.mock.calls[2]!
    expect(url).toBe('/api/translator/translate')
    expect(postBody(fetchMock.mock.calls[2]).targetLocales).toEqual(['ca'])
  })

  it('refreshes the language states when the drawer opens', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        respond(status([row({ locale: 'en', state: 'done', translatedAt: 'x' })])),
      )
      .mockResolvedValue(respond(status([staleEn])))
    vi.stubGlobal('fetch', fetchMock)
    render(<TranslateControl />)

    await openDrawer()

    await waitFor(() => expect(drawer().textContent).toContain('translator:stateStale'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/api/translator/status')
  })

  it('labels languages in the admin language when Payload gives a label per language', async () => {
    i18n.language = 'en'
    localization.locales = [
      { code: 'es', label: { es: 'Español', en: 'Spanish' } },
      { code: 'ca', label: { es: 'Catalán', en: 'Catalan' } },
      { code: 'en', label: { de: 'Englisch' } },
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(status())))
    render(<TranslateControl />)

    await openDrawer()

    expect(screen.getByRole('dialog', { name: /"source":"Spanish"/ })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Catalan' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Englisch' })).toBeTruthy()
  })
})

describe('TranslateControl: options', () => {
  it('renders the overwrite option with its hint and sends it in the request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(status()))
      .mockResolvedValueOnce(respond(status()))
      .mockResolvedValueOnce(respond({ queued: ['ca', 'en'] }, 202))
      .mockResolvedValue(respond(status()))
    vi.stubGlobal('fetch', fetchMock)
    render(<TranslateControl />)

    await openDrawer()
    const overwrite = within(drawer()).getByRole('checkbox', {
      name: 'translator:overwriteEdited',
    })
    expect(checked(overwrite)).toBe(false)
    expect(
      document.getElementById(overwrite.getAttribute('aria-describedby')!)?.textContent,
    ).toBe('translator:overwriteEditedHint')
    await userEvent.click(overwrite)
    await submit()

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
    expect(postBody(fetchMock.mock.calls[2])).toEqual({
      collection: 'events',
      id: 'e1',
      sourceLocale: 'es',
      targetLocales: ['ca', 'en'],
      overwriteEdited: true,
    })
  })

  it('renders one checkbox per declared option', async () => {
    const onChange = vi.fn()
    render(
      <TranslatorProvider
        value={{
          t: ((key: string): string => key) as never,
          language: 'en',
          labelOf: code => code,
          sourceLabelOf: () => '',
          linkOf: () => null,
        }}
      >
        <TranslateOptions
          definitions={[
            {
              id: 'overwriteEdited',
              labelKey: 'a:label' as never,
              hintKey: 'a:hint' as never,
            },
            {
              id: 'future' as never,
              labelKey: 'b:label' as never,
              hintKey: 'b:hint' as never,
            },
          ]}
          values={{ overwriteEdited: false, future: true } as never}
          onChange={onChange}
        />
      </TranslatorProvider>,
    )

    expect(checked(screen.getByRole('checkbox', { name: 'a:label' }))).toBe(false)
    expect(checked(screen.getByRole('checkbox', { name: 'b:label' }))).toBe(true)
    expect(screen.getByText('b:hint')).toBeTruthy()
    await userEvent.click(screen.getByRole('checkbox', { name: 'b:label' }))
    expect(onChange).toHaveBeenCalledWith('future', false)
  })
})

describe('TranslateControl: the live region inside the drawer', () => {
  it('announces from the drawer while it is open and from the bar once closed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(status())))
    render(<TranslateControl />)
    await screen.findByRole('button', { name: 'translator:translate' })
    expect(barRegion().getAttribute('aria-live')).toBe('polite')

    await openDrawer()

    expect(within(drawer()).getByRole('status')).toBeTruthy()
    expect(barRegion().getAttribute('aria-live')).toBe('off')

    await userEvent.click(within(drawer()).getByRole('button', { name: 'general:close' }))
    expect(barRegion().getAttribute('aria-live')).toBe('polite')
  })
})

describe('TranslateControl: focus after "Retry"', () => {
  it('keeps the focus on "Retry" while it is sent and hands it to the row once queued', async () => {
    const failed = status([
      row({ locale: 'ca', state: 'failed', error: 'boom' }),
      row({ locale: 'en' }),
    ])
    const post = deferred()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(respond(failed))
        .mockResolvedValueOnce(respond(failed))
        .mockReturnValueOnce(post.promise)
        .mockResolvedValue(
          respond(
            status([row({ locale: 'ca', state: 'queued' }), row({ locale: 'en' })]),
          ),
        ),
    )
    render(<TranslateControl />)
    await openDrawer(/translator:translate/)
    const retry = within(drawer()).getByRole('button', {
      name: 'translator:retry Català',
    })

    await userEvent.click(retry)

    expect(document.activeElement).toBe(retry)
    expect(retry.getAttribute('aria-disabled')).toBe('true')

    await act(async () => {
      post.resolve(respond({ queued: ['ca'] }, 202))
    })
    await waitFor(() =>
      expect(
        within(drawer()).queryByRole('button', { name: /translator:retry/ }),
      ).toBeNull(),
    )
    expect(document.activeElement).toBe(
      within(drawer()).getByRole('checkbox', { name: 'Català' }),
    )
  })
})
