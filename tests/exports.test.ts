import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Config } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import packageJson from '../package.json' with { type: 'json' }
import * as client from '../src/exports/client.js'
import * as openai from '../src/exports/openai.js'
import * as testing from '../src/exports/testing.js'
import * as root from '../src/index.js'

type Manifest = {
  name: string
  exports: Record<string, unknown>
}

// The real Payload admin pulls CSS in from its dependencies, which Node cannot import;
// all that matters here is what the entry exports.
vi.mock('@payloadcms/ui', () => ({}))

const manifest: Manifest = packageJson

const IMPORT =
  /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g

// Follows the relative imports from `entry` and returns every package it reaches.
const packagesReachedFrom = (entry: string): string[] => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const packages = new Set<string>()
  const visited = new Set<string>()
  const visit = (file: string): void => {
    if (visited.has(file)) return
    visited.add(file)
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2]!
      if (!specifier.startsWith('.')) packages.add(specifier)
      else if (!specifier.endsWith('.css')) visit(sourceOf(file, specifier))
    }
  }
  visit(resolve(root, entry))
  return [...packages]
}

const sourceOf = (from: string, specifier: string): string => {
  const base = resolve(dirname(from), specifier).replace(/\.js$/, '')
  return existsSync(`${base}.ts`) ? `${base}.ts` : `${base}.tsx`
}

const config = {
  localization: { defaultLocale: 'es', locales: ['es', 'en'] },
  collections: [{ slug: 'pages', fields: [] }],
} as unknown as Config

describe('package entry points', () => {
  // Payload resolves this path in the import map of the project that installs the plugin:
  // if it does not point to a published entry that exports the component, the admin cannot
  // find it.
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
    expect(manifest.exports['./client']).toEqual({
      types: './dist/exports/client.d.ts',
      default: './dist/exports/client.js',
    })
    expect(client).toHaveProperty(exportName!)
  })

  // `openai` is an optional peer: an entry that reaches it, even transitively, breaks the
  // projects that do not install it.
  it('only reaches the openai package from the ./openai entry', () => {
    expect(packagesReachedFrom('src/index.ts')).not.toContain('openai')
    expect(packagesReachedFrom('src/exports/client.ts')).not.toContain('openai')
    expect(packagesReachedFrom('src/exports/openai.ts')).toContain('openai')
  })

  it('keeps the OpenAI provider out of the root entry', () => {
    expect(root).not.toHaveProperty('openAIProvider')
    expect(openai).toHaveProperty('openAIProvider')
    expect(manifest.exports['./openai']).toEqual({
      types: './dist/exports/openai.d.ts',
      default: './dist/exports/openai.js',
    })
  })

  it('ships the fake provider from ./testing and not from the root entry', () => {
    expect(root).not.toHaveProperty('fakeProvider')
    expect(testing).toHaveProperty('fakeProvider')
    expect(manifest.exports['./testing']).toEqual({
      types: './dist/exports/testing.d.ts',
      default: './dist/exports/testing.js',
    })
  })

  // npm ignores `publishConfig.exports`: the manifest has to point at `dist` as it is, and
  // TypeScript only honours the `types` condition when it comes first.
  it('points every code entry at dist with the types condition first', () => {
    const codeEntries = Object.entries(manifest.exports).filter(
      ([key]) => key !== './package.json',
    )
    expect(codeEntries.map(([key]) => key)).toEqual([
      '.',
      './client',
      './openai',
      './testing',
    ])
    for (const [, entry] of codeEntries) {
      expect(Object.keys(entry as object)).toEqual(['types', 'default'])
      for (const target of Object.values(entry as object)) {
        expect(target).toMatch(/^\.\/dist\//)
      }
    }
  })
})

describe('root entry', () => {
  it('exposes the records slug and the task slug for migrations and cron setups', () => {
    expect(root.RECORDS_SLUG).toBe('translation-records')
    expect(root.TRANSLATE_TASK_SLUG).toBe('translateDocument')
  })
})
