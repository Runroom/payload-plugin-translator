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
const editDepth = { value: 1 }
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
    newTab,
    onClick,
    url,
  }: {
    children?: ReactNode
    className?: string
    disabled?: boolean
    el?: string
    extraButtonProps?: Record<string, unknown>
    newTab?: boolean
    onClick?: () => void
    url?: string
  }): ReactElement =>
    el === 'anchor' ? (
      // Como el real: con `onClick` cancela la navegación.
      <a
        className={className}
        href={url}
        target={newTab ? '_blank' : undefined}
        rel={newTab ? 'noopener noreferrer' : undefined}
        onClick={
          onClick
            ? (event): void => {
                event.preventDefault()
                onClick()
              }
            : undefined
        }
        {...extraButtonProps}
      >
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
    useEditDepth: (): number => editDepth.value,
    XIcon: (): ReactElement => <svg />,
    useDocumentInfo: (): object => documentInfo,
    useLocale: (): object => locale,
    useConfig: (): object => ({
      config: {
        serverURL: '',
        routes: { api: '/api', admin: '/admin' },
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

// Como el servidor: un elemento por idioma de la entidad, el abierto incluido (si el
// fixture no lo trae, se añade sin traducir).
const status = (locales?: LocaleFixture[]): Record<string, unknown> => ({
  enabled: true,
  locales: !locales
    ? [row({ locale: 'es' }), row({ locale: 'ca' }), row({ locale: 'en' })]
    : locales.some(item => item.locale === locale.code)
      ? locales
      : [row({ locale: locale.code }), ...locales],
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

// La que anuncia: la del drawer mientras está abierto, la de la barra si no.
const liveRegion = (): HTMLElement =>
  screen.queryByRole('dialog')
    ? within(drawer()).getByRole('status')
    : screen.getByRole('status')

const postBody = (call: unknown[] | undefined): Record<string, unknown> =>
  JSON.parse((call?.[1] as { body: string }).body) as Record<string, unknown>

beforeEach(() => {
  locale.code = 'es'
  i18n.language = 'es'
  editDepth.value = 1
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
    ['forbidden', respond({ error: 'forbidden' }, 403)],
    ['notFound', respond({ error: 'not-found' }, 404)],
    ['badRequest', respond({ error: 'bad-request' }, 400)],
    ['recordsFailed', respond({ error: 'records-failed', queued: ['ca', 'en'] }, 500)],
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

  it('keeps «Review» inert until no requested language is in progress', async () => {
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

  it('keeps «Retry» inert while something is in progress', async () => {
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

const barRegion = (): HTMLElement =>
  screen.getAllByRole('status').find(region => !region.closest('dialog'))!

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

describe('TranslateControl: focus after «Retry»', () => {
  it('keeps the focus on «Retry» while it is sent and hands it to the row once queued', async () => {
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

// Como `fetch`: queda pendiente hasta que se aborta, y entonces rechaza.
const abortable = (signal: AbortSignal | undefined): Promise<Response> =>
  new Promise((_, reject) => {
    signal?.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'))
    })
  })

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

describe('TranslateControl: in a nested document drawer', () => {
  it('links «Review» to the document itself in a new tab', async () => {
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
