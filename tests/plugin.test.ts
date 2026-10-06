import type { Config, Plugin } from 'payload'
import { describe, expect, it } from 'vitest'

import { translatorPlugin } from '../src/index.js'
import { fakeProvider } from '../src/provider/fake.js'

const baseConfig = (): Config =>
  ({
    localization: {
      defaultLocale: 'es',
      locales: [
        { code: 'es', label: 'Español' },
        { code: 'ca', label: 'Català' },
        { code: 'en', label: 'English' },
      ],
    },
    collections: [
      {
        slug: 'events',
        versions: { drafts: true },
        fields: [{ name: 'title', type: 'text', localized: true }],
        admin: { components: { edit: { beforeDocumentControls: ['/existing#Thing'] } } },
      },
      { slug: 'people', fields: [] },
    ],
    globals: [
      {
        slug: 'footer',
        fields: [{ name: 'tagline', type: 'text', localized: true }],
        admin: {
          components: { elements: { beforeDocumentControls: ['/existing#Other'] } },
        },
      },
      { slug: 'menu', fields: [] },
    ],
    i18n: { translations: { es: { general: { foo: 'bar' } } } },
  }) as unknown as Config

const plugin = translatorPlugin({
  collections: { events: {} },
  provider: fakeProvider(),
  access: () => true,
})

describe('translatorPlugin', () => {
  it('adds the control to configured collections only, keeping existing components', async () => {
    const config = await plugin(baseConfig())
    const events = config.collections!.find(collection => collection.slug === 'events')!
    const people = config.collections!.find(collection => collection.slug === 'people')!

    expect(events.admin?.components?.edit?.beforeDocumentControls).toEqual([
      '/existing#Thing',
      '@runroom/payload-plugin-translator/client#TranslateControl',
    ])
    expect(people.admin?.components?.edit?.beforeDocumentControls).toBeUndefined()
  })

  it('registers the records collection, the task and the endpoints', async () => {
    const config = await plugin(baseConfig())

    expect(
      config.collections!.some(collection => collection.slug === 'translation-records'),
    ).toBe(true)
    expect(config.jobs?.tasks?.map(task => task.slug)).toContain('translateDocument')
    expect(config.endpoints?.map(endpoint => endpoint.path)).toEqual(
      expect.arrayContaining(['/translator/translate', '/translator/status']),
    )
  })

  it('merges its admin texts without dropping the project ones', async () => {
    const config = await plugin(baseConfig())
    const es = config.i18n?.translations?.es as Record<string, Record<string, string>>

    expect(es.general?.foo).toBe('bar')
    expect(es.translator?.translate).toBe('Traducir')
  })

  it('registers everything even without a provider, so the schema never depends on env', async () => {
    const config = await translatorPlugin({
      collections: { events: {} },
      provider: null,
      access: () => true,
    })(baseConfig())

    const events = config.collections!.find(collection => collection.slug === 'events')!

    expect(
      config.collections!.some(collection => collection.slug === 'translation-records'),
    ).toBe(true)
    expect(config.jobs?.tasks?.map(task => task.slug)).toContain('translateDocument')
    expect(config.endpoints?.map(endpoint => endpoint.path)).toEqual(
      expect.arrayContaining(['/translator/translate', '/translator/status']),
    )
    expect(events.admin?.components?.edit?.beforeDocumentControls).toContain(
      '@runroom/payload-plugin-translator/client#TranslateControl',
    )
  })

  it('accepts a collection without drafts, which the job writes directly', async () => {
    const config = baseConfig()
    delete config.collections![0]!.versions

    const result = await plugin(config)
    const events = result.collections!.find(collection => collection.slug === 'events')!

    expect(events.admin?.components?.edit?.beforeDocumentControls).toContain(
      '@runroom/payload-plugin-translator/client#TranslateControl',
    )
  })

  it('refuses a configured collection that does not exist', () => {
    const config = baseConfig()

    expect(() =>
      translatorPlugin({
        collections: { courses: {} },
        provider: null,
        access: () => true,
      })(config),
    ).toThrow(/courses/)
  })

  it('refuses locales missing from localization', () => {
    expect(() =>
      translatorPlugin({
        collections: { events: { locales: ['es', 'de'] } },
        provider: null,
        access: () => true,
      })(baseConfig()),
    ).toThrow(/de/)
  })

  it('refuses an entity with fewer than two locales to translate between', () => {
    const withLocales = (locales: string[]): Plugin =>
      translatorPlugin({
        collections: { events: { locales } },
        provider: null,
        access: () => true,
      })

    expect(() => withLocales([])(baseConfig())).toThrow(/events/)
    expect(() => withLocales(['es'])(baseConfig())).toThrow(/events/)
    expect(() => withLocales(['es', 'es'])(baseConfig())).toThrow(/events/)
  })

  it('refuses a collection with localized containers', () => {
    const config = baseConfig()
    config.collections![0]!.fields.push({
      name: 'faq',
      type: 'array',
      localized: true,
      fields: [],
    })

    expect(() => plugin(config)).toThrow(/faq/)
  })

  it('refuses a localized container inside a block referenced from config.blocks', () => {
    const config = baseConfig()
    config.blocks = [
      {
        slug: 'faqBlock',
        fields: [{ name: 'items', type: 'array', localized: true, fields: [] }],
      },
    ]
    config.collections![0]!.fields.push({
      name: 'layout',
      type: 'blocks',
      blocks: [],
      blockReferences: ['faqBlock' as never],
    })

    expect(() => plugin(config)).toThrow(/items/)
  })

  it('refuses to run without localization', () => {
    const config = baseConfig()
    delete config.localization

    expect(() => plugin(config)).toThrow(/localization/)
  })
})

// El status lista los idiomas de la entidad en el orden de la config: es la forma de ver
// qué `locales` resolvió el plugin.
const statusLocales = async (options: { locales?: string[] }): Promise<string[]> => {
  const config = await translatorPlugin({
    collections: { events: options },
    provider: null,
    access: () => true,
  })(baseConfig())
  const handler = config.endpoints!.find(item => item.path === '/translator/status')!
    .handler as (req: unknown) => Promise<Response>
  const req = {
    searchParams: new URLSearchParams('collection=events&id=e1'),
    payload: {
      collections: { events: { config: { fields: [], versions: { drafts: true } } } },
      globals: { config: [] },
      config: { blocks: [], localization: { defaultLocale: 'es' } },
      find: async (): Promise<{ docs: unknown[] }> => ({ docs: [] }),
      findByID: async (): Promise<{ id: string }> => ({ id: 'e1' }),
    },
  }
  const body = (await (await handler(req)).json()) as { locales: { locale: string }[] }
  return body.locales.map(item => item.locale)
}

describe('translatorPlugin locales', () => {
  it('translates between every locale of localization by default', async () => {
    expect(await statusLocales({})).toEqual(['es', 'ca', 'en'])
  })

  it('limits an entity to the locales it is given', async () => {
    expect(await statusLocales({ locales: ['ca', 'en'] })).toEqual(['ca', 'en'])
  })
})

describe('translatorPlugin with globals', () => {
  const withGlobals = (globals: Record<string, object>): Plugin =>
    translatorPlugin({
      collections: {},
      globals,
      provider: null,
      access: () => true,
    })

  it('adds the control before the document controls of configured globals only', async () => {
    const config = await withGlobals({ footer: {} })(baseConfig())
    const footer = config.globals!.find(global => global.slug === 'footer')!
    const menu = config.globals!.find(global => global.slug === 'menu')!

    expect(footer.admin?.components?.elements?.beforeDocumentControls).toEqual([
      '/existing#Other',
      '@runroom/payload-plugin-translator/client#TranslateControl',
    ])
    expect(menu.admin?.components?.elements?.beforeDocumentControls).toBeUndefined()
  })

  it('refuses a configured global that does not exist', () => {
    expect(() => withGlobals({ header: {} })(baseConfig())).toThrow(/header/)
  })

  it('refuses a global with locales missing from localization', () => {
    expect(() =>
      withGlobals({ footer: { locales: ['es', 'de'] } })(baseConfig()),
    ).toThrow(/de/)
  })

  it('refuses a global with a single locale', () => {
    expect(() => withGlobals({ footer: { locales: ['es'] } })(baseConfig())).toThrow(
      /footer/,
    )
  })

  it('refuses a global with localized containers', () => {
    const config = baseConfig()
    config.globals![0]!.fields.push({
      name: 'columns',
      type: 'array',
      localized: true,
      fields: [],
    })

    expect(() => withGlobals({ footer: {} })(config)).toThrow(/columns/)
  })
})
