import { act, cleanup, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import type { ReactElement, ReactNode } from 'react'
import { afterEach, beforeEach, vi } from 'vitest'

export { modals, reloadPage }

const reloadPage = vi.hoisted(() => vi.fn())

export const locale = { code: 'es' }
export const documentInfo: {
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
export const i18n = { language: 'es' }
export const editDepth = { value: 1 }
export const defaultLocales = [
  { code: 'es', label: 'Español' as string | Record<string, string> },
  { code: 'ca', label: 'Català' as string | Record<string, string> },
  { code: 'en', label: 'English' as string | Record<string, string> },
]
export const localization = { defaultLocale: 'es', locales: defaultLocales }

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

// The factory of the `@payloadcms/ui` mock. `vi.mock` is hoisted per file, so every test
// file declares its own, delegating here with a lazy `import`.
export const payloadUiMock = async (): Promise<object> => {
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
      // Like the real one: with `onClick` it cancels the navigation.
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
}

export type LocaleFixture = {
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

export const row = (
  overrides: Partial<LocaleFixture> & { locale: string },
): LocaleFixture => ({
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

// Like the server: one item per locale of the entity, the open one included (if the
// fixture does not bring it, it is added untranslated).
export const status = (locales?: LocaleFixture[]): Record<string, unknown> => ({
  enabled: true,
  locales: !locales
    ? [row({ locale: 'es' }), row({ locale: 'ca' }), row({ locale: 'en' })]
    : locales.some(item => item.locale === locale.code)
      ? locales
      : [row({ locale: locale.code }), ...locales],
})

export const staleEn = row({
  locale: 'en',
  state: 'done',
  sourceLocale: 'es',
  stale: true,
  changed: 3,
  translatedAt: '2026-10-05T10:00:00.000Z',
})

export const checked = (element: HTMLElement): boolean =>
  (element as HTMLInputElement).checked

export const respond = (body: unknown, statusCode = 200): Response =>
  new Response(JSON.stringify(body), { status: statusCode })

export const deferred = (): {
  promise: Promise<Response>
  resolve: (value: Response) => void
} => {
  let resolve: (value: Response) => void = () => {}
  const promise = new Promise<Response>(done => {
    resolve = done
  })
  return { promise, resolve }
}

export const settle = async (): Promise<void> => {
  await act(async () => {})
}

export const drawer = (): HTMLElement => screen.getByRole('dialog')

export const openDrawer = async (
  name: string | RegExp = 'translator:translate',
): Promise<HTMLElement> => {
  const toggle = await screen.findByRole('button', { name })
  await userEvent.click(toggle)
  return toggle
}

export const submit = async (): Promise<void> => {
  await userEvent.click(
    within(drawer()).getByRole('button', { name: 'translator:submit' }),
  )
}

// The one that announces: the drawer's while it is open, the bar's otherwise.
export const liveRegion = (): HTMLElement =>
  screen.queryByRole('dialog')
    ? within(drawer()).getByRole('status')
    : screen.getByRole('status')

export const postBody = (call: unknown[] | undefined): Record<string, unknown> =>
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

export const advance = async (ms = 2_000): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

export const doneCa = row({ locale: 'ca', state: 'done', translatedAt: 'x' })

export const barRegion = (): HTMLElement =>
  screen.getAllByRole('status').find(region => !region.closest('dialog'))!

// Like `fetch`: it stays pending until aborted, and then rejects.
export const abortable = (signal: AbortSignal | undefined): Promise<Response> =>
  new Promise((_, reject) => {
    signal?.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'))
    })
  })
