import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypedUser } from 'payload'
import { buildConfig } from 'payload'

import { fakeProvider } from '../src/exports/testing.js'
import { translatorPlugin } from '../src/index.js'

type Role = { slug?: string } | number | string

// Only populated roles can say what they are: at depth 0 (ids only) no role is found.
const hasRole = (user: TypedUser | null, slug: string): boolean =>
  (user?.roles as Role[] | null | undefined)?.some(
    role => typeof role === 'object' && role.slug === slug,
  ) === true

/**
 * SQLite file the app writes to. Each import gets its own file under the OS temp dir, so
 * every integration test file starts from an empty database; `DATABASE_URL` overrides it.
 */
export const databaseFile = join(tmpdir(), `payload-translator-${randomUUID()}.db`)

/** The provider the plugin uses, exposed so an integration test can spy on it. */
export const provider = fakeProvider()

export default buildConfig({
  secret: process.env.PAYLOAD_SECRET ?? 'payload-plugin-translator-dev-secret',
  // Outside production the adapter pushes the schema on connect. SQLite transactions are
  // off unless `transactionOptions` is set, and libsql runs each one on its own connection
  // without a busy timeout, so concurrent writes would fail with SQLITE_BUSY: they are only
  // turned on for the test that needs a real rollback (`PAYLOAD_SQLITE_TRANSACTIONS=1`).
  db: sqliteAdapter({
    client: { url: process.env.DATABASE_URL ?? `file:${databaseFile}` },
    ...(process.env.PAYLOAD_SQLITE_TRANSACTIONS === '1'
      ? { transactionOptions: {} }
      : {}),
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
    {
      slug: 'users',
      // `req.user` is bound with its roles populated, as the `guarded` update rule needs.
      auth: { depth: 1 },
      fields: [
        // Flags the `guarded` access rules look at; both can change after a job is queued.
        { name: 'canTranslate', type: 'checkbox', defaultValue: true },
        {
          name: 'role',
          type: 'select',
          options: ['editor', 'admin'],
          defaultValue: 'editor',
        },
        { name: 'roles', type: 'relationship', relationTo: 'roles', hasMany: true },
      ],
    },
    {
      slug: 'roles',
      fields: [
        { name: 'slug', type: 'text', required: true },
        { name: 'title', type: 'text' },
      ],
    },
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
    // Access rules that depend on the locale, the user and the row, which the job must
    // honour as the requester.
    {
      slug: 'guarded',
      versions: { drafts: true },
      access: {
        // A role `no-<locale>` hides that locale; `viewer` forbids every write.
        read: ({ req }): boolean => !hasRole(req.user, `no-${req.locale}`),
        update: ({ req }): boolean =>
          req.locale !== 'fr' &&
          req.user?.canTranslate === true &&
          !hasRole(req.user, 'viewer'),
      },
      fields: [
        { name: 'title', type: 'text', localized: true },
        {
          name: 'secretNote',
          type: 'text',
          localized: true,
          access: { read: ({ req }): boolean => req.user?.role === 'admin' },
        },
        {
          name: 'items',
          type: 'array',
          fields: [
            {
              name: 'text',
              type: 'text',
              localized: true,
              // `siblingData` is the row when a document is saved and absent when Payload
              // computes schema-level permissions.
              access: {
                update: ({ siblingData }): boolean => siblingData?.locked !== true,
              },
            },
            { name: 'locked', type: 'checkbox', defaultValue: false },
          ],
        },
      ],
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
      collections: { posts: {}, pages: {}, guarded: {} },
      globals: { footer: {} },
      provider,
      access: ({ req }) => Boolean(req.user),
    }),
  ],
})
