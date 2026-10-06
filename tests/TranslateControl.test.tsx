import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import type { ReactElement, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TranslateControl } from '../src/ui/TranslateControl.js'
import { TranslateOptions } from '../src/ui/TranslateOptions.js'

const reloadPage = vi.hoisted(() => vi.fn())
vi.mock('../src/ui/reloadPage.js', () => ({ reloadPage }))

const locale = { code: 'es' }
const documentInfo: {
  id: number | string | undefined
  collectionSlug: string | undefined
  globalSlug?: string
  hasPublishedDoc: boolean
  unpublishedVersionCount: number
} = {
  id: 'e1',
  collectionSlug: 'events',
  hasPublishedDoc: true,
  unpublishedVersionCount: 0,
}
const i18n = { language: 'es' }
const defaultLocales = [
  { code: 'es', label: 'Español' as string | Record<string, string> },
  { code: 'ca', label: 'Català' as string | Record<string, string> },
  { code: 'en', label: 'English' as string | Record<string, string> },
]
const localization = { defaultLocale: 'es', locales: defaultLocales }

// Payload's ModalProvider in miniature: which drawer slugs are open, shared by every
// `useModal` consumer so the control and the drawer see the same state.
const modals = vi.hoisted(() => {
  const open = new Set<string>()
  const listeners = new Set<() => void>()
  let version = 0
  const emit = (): void => {
    version += 1
    listeners.forEach(listener => listener())
  }
  return {
    open,
    version: (): number => version,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return (): void => {
        listeners.delete(listener)
      }
    },
    openModal: (slug: string): void => {
      open.add(slug)
      emit()
    },
    closeModal: (slug: string): void => {
      open.delete(slug)
      emit()
    },
    reset: (): void => {
      open.clear()
      emit()
    },
  }
})

vi.mock('@payloadcms/ui', async () => {
  const { useSyncExternalStore } = await import('react')
  const useModal = (): object => {
    useSyncExternalStore(modals.subscribe, modals.version)
    return {
      openModal: modals.openModal,
      closeModal: modals.closeModal,
      isModalOpen: (slug: string): boolean => modals.open.has(slug),
    }
  }
  const Drawer = ({
    slug,
    Header,
    children,
  }: {
    slug: string
    Header?: ReactNode
    children: ReactNode
  }): ReactElement | null => {
    useModal()
    if (!modals.open.has(slug)) return null
    return (
      <dialog open aria-modal="true" aria-label={slug} id={slug}>
        {Header}
        {children}
      </dialog>
    )
  }
  // Payload's Button in miniature: `disabled` and `aria-disabled` behave like the real one.
  const Button = ({
    children,
    className,
    disabled,
    el,
    extraButtonProps,
    onClick,
    url,
  }: {
    children?: ReactNode
    className?: string
    disabled?: boolean
    el?: string
    extraButtonProps?: Record<string, unknown>
    onClick?: () => void
    url?: string
  }): ReactElement =>
    el === 'anchor' ? (
      <a className={className} href={url}>
        {children}
      </a>
    ) : (
      <button
        type="button"
        className={className}
        disabled={disabled}
        aria-disabled={disabled}
        onClick={onClick}
        {...extraButtonProps}
      >
        {children}
      </button>
    )
  return {
    Button,
    Drawer,
    useModal,
    useDrawerSlug: (slug: string): string => `drawer_1_${slug}`,
    XIcon: (): ReactElement => <svg />,
    useDocumentInfo: (): object => documentInfo,
    useLocale: (): object => locale,
    useConfig: (): object => ({
      config: {
        serverURL: '',
        routes: { api: '/api' },
        localization,
      },
    }),
    useTranslation: (): object => ({
      i18n,
      t: (key: string, vars?: Record<string, unknown>): string =>
        `${key}${vars ? JSON.stringify(vars) : ''}`,
    }),
  }
})

type LocaleFixture = {
  locale: string
  state: 'none' | 'queued' | 'running' | 'done' | 'failed'
  sourceLocale: string | null
  stale: boolean
  changed: number
  missing: number
  error: string | null
  translatedAt: string | null
  kept: number
}

const row = (overrides: Partial<LocaleFixture> & { locale: string }): LocaleFixture => ({
  state: 'none',
  sourceLocale: null,
  stale: false,
  changed: 0,
  missing: 0,
  error: null,
  translatedAt: null,
  kept: 0,
  ...overrides,
})

// Como el servidor: un elemento por idioma de la entidad, el abierto incluido.
const status = (locales?: LocaleFixture[]): Record<string, unknown> => ({
  enabled: true,
  locales: locales ?? [
    row({ locale: 'es' }),
    row({ locale: 'ca' }),
    row({ locale: 'en' }),
  ],
})

const staleEn = row({
  locale: 'en',
  state: 'done',
  sourceLocale: 'es',
  stale: true,
  changed: 3,
  translatedAt: '2026-10-05T10:00:00.000Z',
})

const checked = (element: HTMLElement): boolean => (element as HTMLInputElement).checked

const respond = (body: unknown, statusCode = 200): Response =>
  new Response(JSON.stringify(body), { status: statusCode })

const deferred = (): {
  promise: Promise<Response>
  resolve: (value: Response) => void
} => {
  let resolve: (value: Response) => void = () => {}
  const promise = new Promise<Response>(done => {
    resolve = done
  })
  return { promise, resolve }
}

const settle = async (): Promise<void> => {
  await act(async () => {})
}

const drawer = (): HTMLElement => screen.getByRole('dialog')

const openDrawer = async (
  name: string | RegExp = 'translator:translate',
): Promise<HTMLElement> => {
  const toggle = await screen.findByRole('button', { name })
  await userEvent.click(toggle)
  return toggle
}

const submit = async (): Promise<void> => {
  await userEvent.click(
    within(drawer()).getByRole('button', { name: 'translator:submit' }),
  )
}

const liveRegion = (): HTMLElement => screen.getByRole('status')

const postBody = (call: unknown[] | undefined): Record<string, unknown> =>
  JSON.parse((call?.[1] as { body: string }).body) as Record<string, unknown>

beforeEach(() => {
  locale.code = 'es'
  i18n.language = 'es'
  localization.locales = defaultLocales
  documentInfo.id = 'e1'
  documentInfo.collectionSlug = 'events'
  documentInfo.hasPublishedDoc = true
  documentInfo.unpublishedVersionCount = 0
  delete documentInfo.globalSlug
})

afterEach(() => {
  reloadPage.mockReset()
  cleanup()
  modals.reset()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

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

const advance = async (ms = 2_000): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

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

  it('polls the status while something is in progress', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    locale.code = 'ca'
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(status([row({ locale: 'en', state: 'queued' })])))
      .mockResolvedValueOnce(respond(status([row({ locale: 'en', state: 'running' })])))
      .mockResolvedValue(
        respond(status([row({ locale: 'en', state: 'done', translatedAt: 'x' })])),
      )
    vi.stubGlobal('fetch', fetchMock)
    render(<TranslateControl />)

    expect(
      await screen.findByRole('button', { name: 'translator:inProgress' }),
    ).toBeTruthy()
    await advance()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await advance()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await advance()
    expect(fetchMock).toHaveBeenCalledTimes(3)
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
    expect(screen.getByText('translator:readyShort')).toBeTruthy()
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
      <TranslateOptions
        definitions={[
          { id: 'overwriteEdited', labelKey: 'a:label', hintKey: 'a:hint' },
          { id: 'future' as never, labelKey: 'b:label', hintKey: 'b:hint' },
        ]}
        values={{ overwriteEdited: false, future: true } as never}
        onChange={onChange}
        t={(key: never): string => key}
      />,
    )

    expect(checked(screen.getByRole('checkbox', { name: 'a:label' }))).toBe(false)
    expect(checked(screen.getByRole('checkbox', { name: 'b:label' }))).toBe(true)
    expect(screen.getByText('b:hint')).toBeTruthy()
    await userEvent.click(screen.getByRole('checkbox', { name: 'b:label' }))
    expect(onChange).toHaveBeenCalledWith('future', false)
  })
})

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
    ['requestFailed', respond({ error: 'boom' }, 500)],
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

  it('offers «Review» only once no requested language is in progress', async () => {
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
    expect(screen.queryByRole('link', { name: /translator:review/ })).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(
      within(drawer()).getAllByRole('link', { name: /translator:review/ }),
    ).toHaveLength(2)
  })

  it('offers «Retry» only once nothing is in progress', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          respond(
            status([
              row({ locale: 'ca', state: 'failed', error: 'boom' }),
              row({ locale: 'en', state: 'running' }),
            ]),
          ),
        ),
    )
    render(<TranslateControl />)

    await openDrawer('translator:inProgress')

    expect(within(drawer()).getByRole('checkbox', { name: 'Català' })).toBeTruthy()
    expect(
      within(drawer()).queryByRole('button', { name: /translator:retry/ }),
    ).toBeNull()
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

const doneCa = row({ locale: 'ca', state: 'done', translatedAt: 'x' })

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

  // Publicar no recarga la página: Payload pone el contador a 0 en `useDocumentInfo`.
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
