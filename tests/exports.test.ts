import type { Config } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import packageJson from '../package.json' with { type: 'json' }
import * as client from '../src/exports/client.js'
import * as openai from '../src/exports/openai.js'
import * as root from '../src/index.js'

type Manifest = {
  name: string
  exports: Record<string, unknown>
  publishConfig: { exports: Record<string, unknown> }
}

// El admin real de Payload arrastra CSS de sus dependencias, que Node no sabe importar;
// aquí solo importa qué exporta la entrada.
vi.mock('@payloadcms/ui', () => ({}))

const manifest: Manifest = packageJson

const config = {
  localization: { defaultLocale: 'es', locales: ['es', 'en'] },
  collections: [{ slug: 'pages', fields: [] }],
} as unknown as Config

describe('package entry points', () => {
  // Payload resuelve esta ruta en el importMap del proyecto que instala el plugin: si no
  // apunta a una entrada publicada que exporte el componente, el admin no lo encuentra.
  it('registers the control through the published ./client entry', async () => {
    const result = await root.translatorPlugin({
      collections: { pages: {} },
      provider: null,
      access: () => true,
    })(config)
    const pages = result.collections!.find(collection => collection.slug === 'pages')!
    const [specifier, exportName] = String(
      pages.admin?.components?.edit?.beforeDocumentControls?.[0],
    ).split('#')

    expect(specifier).toBe(`${manifest.name}/client`)
    expect(specifier).toBe('@runroom/payload-plugin-translator/client')
    expect(manifest.exports).toHaveProperty('./client')
    expect(manifest.publishConfig.exports).toHaveProperty('./client')
    expect(client).toHaveProperty(exportName!)
  })

  it('keeps the OpenAI provider out of the root entry', () => {
    expect(root).not.toHaveProperty('openAIProvider')
    expect(openai).toHaveProperty('openAIProvider')
    expect(manifest.publishConfig.exports).toHaveProperty('./openai')
  })
})
