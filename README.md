# @runroom/payload-plugin-translator

A [Payload CMS](https://payloadcms.com) plugin that translates the localized fields of
collections and globals with AI, from the locale open in the admin into the entity's other
locales, without overwriting text someone edited by hand.

- Entities **with drafts** (`versions.drafts`) receive the translation as a draft: an
  editor reviews it and publishes it with Payload's own Publish button.
- Entities **without drafts** are written directly, so the translation is published at
  once (the drawer warns about it before translating).
- Any locale can be the source: the one open in the admin is translated into the others.
- Localized `text` (not `hasMany`), `textarea` and Lexical `richText` fields are
  translated, including inside arrays, groups and blocks (as long as the container itself
  is not localized, see [Limitations](#known-limitations)).

## Installation

```bash
pnpm add @runroom/payload-plugin-translator
# only if you use the bundled OpenAI provider
pnpm add openai
```

Peer dependencies: `payload` and `@payloadcms/ui` `^3.90.2`, `react` and `react-dom`
`^19`, and optionally `openai` `^7`.

## Usage

```ts
// payload.config.ts
import { buildConfig } from 'payload'
import { translatorPlugin } from '@runroom/payload-plugin-translator'
import { openAIProvider } from '@runroom/payload-plugin-translator/openai'

export default buildConfig({
  // ...
  localization: {
    defaultLocale: 'en',
    locales: ['en', 'es', 'ca'],
  },
  plugins: [
    translatorPlugin({
      collections: { pages: {}, posts: { locales: ['en', 'es'] } },
      globals: { footer: {} },
      provider: process.env.OPENAI_API_KEY
        ? openAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-5-mini' })
        : null,
      access: ({ req }) => Boolean(req.user),
    }),
  ],
})
```

After adding the plugin:

1. Regenerate the admin import map (`payload generate:importmap`): the plugin registers
   the `@runroom/payload-plugin-translator/client#TranslateControl` component.
2. Create and run a **database migration** (`payload migrate:create`): the plugin adds the
   `translation-records` collection and the `translateDocument` job task (with its input
   schema) to your config.
3. Make sure the jobs queue is processed (see [How it works](#how-it-works)).

## Options

`translatorPlugin(options)`:

| Option         | Type                                                                   | Default          | Description                                                                                                                                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collections`  | `Record<string, { locales?: string[] }>`                               | required         | Collections to translate, by slug. `locales` are the locales the entity is translated between; it defaults to every locale in `localization`. They must exist in `localization` and be at least two. `{}` is enough in the usual case.                                            |
| `globals`      | `Record<string, { locales?: string[] }>`                               | `{}`             | Globals to translate, same shape as `collections`.                                                                                                                                                                                                                                |
| `provider`     | `TranslationProvider \| null`                                          | required         | The translation backend. With `null` the plugin still registers the same schema, but the button is hidden: `POST /translate` answers 503 and `GET /status` answers `enabled: false`. Use it to run without an API key.                                                            |
| `instructions` | `({ sourceLocale, targetLocale }) => string`                           | `() => ''`       | Extra instructions for the model (context, tone, terminology). Appended to the provider's own prompt.                                                                                                                                                                             |
| `access`       | `({ req }) => boolean \| Promise<boolean>`                             | required         | Who may translate and see the status. It guards both endpoints and the `translation-records` collection. The endpoints run outside Payload's collection access control, so put every check you need here (e.g. a second factor).                                                  |
| `queue`        | `string`                                                               | `'translations'` | Jobs queue the translation jobs are queued in.                                                                                                                                                                                                                                    |
| `onLiveWrite`  | `({ req, entityType, slug, docId, locales }) => void \| Promise<void>` | —                | Called once per finished translation of an entity **without drafts**, so you can revalidate the public site (e.g. `revalidatePath`). It is called from `GET /status`, which is a real request, because the job itself runs outside one. Errors are caught and logged as warnings. |

Excluding a field: add `custom: { translator: 'exclude' }` to the field config. Useful for
values recomputed by hooks (search text) or that must not be translated (a postal
address).

### Entry points

| Import                                      | Exports                                                                                                                                                                                                                     |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@runroom/payload-plugin-translator`        | `translatorPlugin`, `fakeProvider`, `ProviderError`, `isTranslatorWrite`, `TRANSLATOR_WRITE_CONTEXT`, and the types `TranslatorPluginOptions`, `TranslationProvider`, `TranslateRequest`, `TranslatorAccess`, `OnLiveWrite` |
| `@runroom/payload-plugin-translator/openai` | `openAIProvider` and the type `OpenAIClientLike`. Kept apart so `openai` stays an optional dependency.                                                                                                                      |
| `@runroom/payload-plugin-translator/client` | `TranslateControl`, the admin component the plugin registers (you do not import it yourself).                                                                                                                               |

### Providers

- `openAIProvider({ apiKey, model, client? })` uses the OpenAI Responses API with a strict
  JSON schema, a 60 s timeout and one SDK retry. Refusals, content-filter cuts and
  400/401/403/404/422 errors are not retried; a response cut by `max_output_tokens`, a
  429, a 5xx or a network error is.
- `fakeProvider({ delayMs? })` prefixes every value with `[<locale>] `. Meant for tests
  and E2E runs without an API key.
- A custom provider implements
  `{ translate({ sourceLocale, targetLocale, instructions, units }) }` and returns an
  object with exactly the same keys as `units`. Values may contain numbered tags
  (`<1>…</1>`, `<2/>`) that must be kept unchanged. Throw
  `new ProviderError(message, retryable)` to tell the job whether retrying makes sense.

### Recognising the translator's writes

The translator writes without a user and with its own request `context`. Use
`isTranslatorWrite(context)` in your hooks to tell its writes apart, for example to skip
revalidating the public site on a draft write, or to keep a sync from claiming a field the
translator wrote.

## How it works

- **Admin UI.** A «Translate» button is added to the document controls of every configured
  collection (`admin.components.edit.beforeDocumentControls`) and global
  (`admin.components.elements.beforeDocumentControls`). It opens a drawer titled
  «Translate from {open locale}» listing the other locales with their state (not
  translated, up to date, out of date, queued, translating, draft ready / published,
  error), where each was translated from and when, the fields changed in its source and
  the fields empty in the target. Admin strings ship in English and Spanish.
- **Records.** The `translation-records` collection (hidden in the admin) keeps one record
  per entity and target locale: status, source locale, a fingerprint of every translated
  field, kept fields, error and timestamps. Fingerprints follow array/block row ids, so
  reordering rows does not make a translation stale.
- **Job.** `POST /api/translator/translate` queues one `translateDocument` job per
  document with every target locale, and runs it right away filtered by the queued job
  ids. The locales are translated in sequence so two writes never start from the same
  version. Non-recoverable errors cancel the job; the rest are retried twice with
  exponential backoff. To pick up jobs that were queued but not run (after a restart, for
  instance), schedule the queue in your config:

  ```ts
  jobs: {
    autoRun: [{ cron: '* * * * *', queue: 'translations', limit: 5 }],
  }
  ```

  A job that dies mid-run leaves its record in `running`; it stops blocking new
  translations after 15 minutes.

- **Endpoints.**
  - `POST /api/translator/translate` with `{ collection, id }` or `{ global }`, plus
    `sourceLocale` (required, the open locale), `targetLocales` and `overwriteEdited`.
    Answers 202 `{ queued }`, 403 when `access` denies it, 400 without a valid target, 404
    when the document or global does not exist, 409 when any locale of the document is
    already being translated, and 503 without a provider.
  - `GET /api/translator/status?collection=…&id=…` (or `?global=…`) answers
    `{ enabled, writesLive, lastPublishedAt, locales }`, with one entry per locale of the
    entity:
    `{ locale, state, sourceLocale, stale, changed, missing, error, translatedAt, kept }`.
    `writesLive` is `true` for entities without drafts. `lastPublishedAt` is the date of
    the latest published version (`null` without drafts or if never published); the admin
    flags a locale as an unpublished draft only when its translation is newer.
- **Drafts vs direct writes.** The mode follows each entity's `versions.drafts`: with
  drafts the job writes with `draft: true`; without them there is nowhere to leave a
  pending translation, so it writes the document directly. Re-reading before and verifying
  after the write, and the fingerprints, work the same in both modes.
- **No-overwrite rule.** The translator only writes a target field that is empty or still
  holds its own last output, whatever the target locale. Text written by anyone else (an
  editor's correction, an import) counts as edited by hand and is kept; the drawer reports
  how many texts were kept. The «Also overwrite texts edited by hand» option is the only
  way to force it.
- **Translating from the open locale.** The state of each locale is measured against the
  locale it was last translated _from_, not against the open one. Translating a locale
  from a different source changes its source.

## Known limitations

- **Localized containers are not supported.** An `array`, `blocks` or `group` field with
  `localized: true` in a configured entity makes the plugin throw at startup, as does a
  configured slug that does not exist or a `locales` list that is not in `localization` or
  has fewer than two locales.
- **The admin UI is coupled to Payload 3.90.** It relies on Payload's admin CSS classes,
  `Drawer`, `Button` and `useDocumentInfo`, and on where 3.90 renders
  `beforeDocumentControls`. That is why the peer range starts at `^3.90.2`.
- **A concurrent edit can overwrite a translation.** Payload does not merge locales
  atomically: an autosave in another locale that lands while the job writes can wipe what
  was translated. The job re-reads the target after writing and fails with a retryable
  error when it does not match.
- Server-side labels (the records collection, the task) and error messages are in Spanish.

## Development

```bash
pnpm install
pnpm test          # vitest (jsdom)
pnpm lint          # oxlint (type-aware) + oxfmt --check + tsc
pnpm fix:lint
pnpm build         # dist/: swc for JS, tsc for declarations, CSS copied
```

During development `exports` point at `src/`; `publishConfig.exports` point at `dist/` for
the published package. A `dev/` Payload app to try the plugin end to end (as in Payload's
plugin template) is still to be added.

## License

MIT © Runroom
