import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildConfig } from 'payload'

import { fakeProvider } from '../src/exports/testing.js'
import { translatorPlugin } from '../src/index.js'

/**
 * SQLite file the app writes to. Each import gets its own file under the OS temp dir, so
 * every integration test file starts from an empty database; `DATABASE_URL` overrides it.
 */
export const databaseFile = join(tmpdir(), `payload-translator-${randomUUID()}.db`)

export default buildConfig({
  secret: process.env.PAYLOAD_SECRET ?? 'payload-plugin-translator-dev-secret',
  // Outside production the adapter pushes the schema on connect, which also creates the
  // `concurrencyKey` column that the plugin's `jobs.enableConcurrencyControl` needs.
  db: sqliteAdapter({
    client: { url: process.env.DATABASE_URL ?? `file:${databaseFile}` },
  }),
  editor: lexicalEditor(),
  // Nothing here needs generated files or the Next admin.
  typescript: { autoGenerate: false },
  graphQL: { disable: true },
  telemetry: false,
  logger: { options: { level: process.env.PAYLOAD_LOG_LEVEL ?? 'error' } },
  localization: { locales: ['en', 'es', 'fr'], defaultLocale: 'en' },
  admin: { user: 'users' },
  collections: [
    { slug: 'users', auth: true, fields: [] },
    {
      slug: 'posts',
      versions: { drafts: true },
      fields: [
        { name: 'title', type: 'text', localized: true, required: true },
        { name: 'body', type: 'richText', localized: true },
        { name: 'slug', type: 'text' },
      ],
    },
    {
      slug: 'pages',
      fields: [{ name: 'title', type: 'text', localized: true, required: true }],
    },
  ],
  globals: [
    {
      slug: 'footer',
      versions: { drafts: true },
      fields: [{ name: 'text', type: 'text', localized: true }],
    },
  ],
  // No `jobs.autoRun`: the integration tests run the queue themselves.
  plugins: [
    translatorPlugin({
      collections: { posts: {}, pages: {} },
      globals: { footer: {} },
      provider: fakeProvider(),
      access: ({ req }) => Boolean(req.user),
    }),
  ],
})
