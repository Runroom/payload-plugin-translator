# @runroom/payload-plugin-translator

A [Payload CMS](https://payloadcms.com) plugin that translates the localized fields of
collections and globals with AI, from the locale open in the admin into the entity's other
locales, without overwriting text someone edited by hand.

- Entities **with drafts** (`versions.drafts`) receive the translation as a draft: an
  editor reviews it and publishes it with Payload's own Publish button.
- Entities **without drafts** are written directly, so the translation goes live at once
  (the drawer warns about it before translating).
- Any locale can be the source: the one open in the admin is translated into the others.
- Localized `text` (not `hasMany`), `textarea` and Lexical `richText` fields are
  translated, including inside arrays, groups, tabs and blocks (as long as the container
  itself is not localized, see [Known limitations](#known-limitations)).

## Requirements

- **Payload `^3.90.2`** with `@payloadcms/ui`, **React 19** and **Node.js `>=22.12.0`**.
- **`localization`** in your Payload config. The plugin throws at startup without it.
- **Something that runs the jobs.** `POST /api/translator/translate` queues a job and
  starts it right away without waiting for it, so the translation runs after the response.
  That needs either:
  - a **long-lived Node process** (`next start`, a container, a VM), where the promise
    outlives the response; or
  - on serverless, an **external cron** that calls Payload's
    `GET /api/payload-jobs/run?queue=translations` (protected by `jobs.access.run`, which
    defaults to any logged-in user).
- **`jobs.autoRun` covering the plugin's queue** (or the external cron above). Without it,
  a job that fails with a retryable error stays queued and its retry never runs. The
  plugin checks this in `onInit` and, when a provider is configured, logs this warning if
  nothing processes the queue:

  ```text
  translatorPlugin: no `jobs.autoRun` entry processes the "translations" queue. Retries of a failed translation will not run until something runs the queue again (for example `autoRun: [{ cron: '* * * * *', queue: 'translations' }]` or an external cron).
  ```

  ```ts
  jobs: {
    autoRun: [{ cron: '* * * * *', queue: 'translations', limit: 5 }],
  }
  ```

## Installation

```bash
pnpm add @runroom/payload-plugin-translator
# only if you use the bundled OpenAI provider
pnpm add openai
```

Peer dependencies: `payload` and `@payloadcms/ui` `^3.90.2`, `react` `^19`, and optionally
`openai` `^7`. The package is ESM only.

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
  jobs: {
    autoRun: [{ cron: '* * * * *', queue: 'translations', limit: 5 }],
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
2. Create and run a **database migration** (`payload migrate:create`, then
   `payload migrate`). The plugin adds to your schema:
   - the `translation-records` collection (one record per entity and target locale, with a
     unique index on `entityType` + `collectionSlug` + `docId` + `targetLocale`);
   - the `translateDocument` job task (with its input schema);
   - the indexed `concurrencyKey` column of the jobs collection, because the plugin turns
     on `jobs.enableConcurrencyControl` so two jobs for the same document never run at
     once. It respects an explicit `enableConcurrencyControl: false` in your config; then
     two simultaneous requests for the same document may run in parallel.
3. Make sure the jobs run (see [Requirements](#requirements)).

## Options

`translatorPlugin(options)`:

| Option         | Type                                                                   | Default          | Description                                                                                                                                                                                                                            |
| -------------- | ---------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collections`  | `Record<string, { locales?: string[] }>`                               | required         | Collections to translate, by slug. `locales` are the locales the entity is translated between; it defaults to every locale in `localization`. They must exist in `localization` and be at least two. `{}` is enough in the usual case. |
| `globals`      | `Record<string, { locales?: string[] }>`                               | `{}`             | Globals to translate, same shape as `collections`.                                                                                                                                                                                     |
| `provider`     | `TranslationProvider \| null`                                          | required         | The translation backend. With `null` the plugin still registers the same schema, but the button is hidden: `POST /translate` answers 503 and `GET /status` answers `enabled: false`. Use it to run without an API key.                 |
| `instructions` | `({ sourceLocale, targetLocale }) => string`                           | `() => ''`       | Extra instructions for the model (context, tone, terminology). Appended to the provider's own prompt.                                                                                                                                  |
| `access`       | `({ req, ref?, operation }) => boolean \| Promise<boolean>`            | required         | Who may use the translator. See [Permissions](#permissions).                                                                                                                                                                           |
| `queue`        | `string`                                                               | `'translations'` | Jobs queue the translation jobs are queued in.                                                                                                                                                                                         |
| `onLiveWrite`  | `({ req, entityType, slug, docId, locales }) => void \| Promise<void>` | —                | Called after a translation of an entity **without drafts**, so you can revalidate the public site (e.g. `revalidatePath`). It only runs from `GET /status`: see [Live writes and `onLiveWrite`](#live-writes-and-onlivewrite).         |

Excluding a field: add `custom: { translator: 'exclude' }` to the field config. Useful for
values recomputed by hooks (search text) or that must not be translated (a postal
address). On a layout field (`row`, `collapsible`, `tabs`, an unnamed `group`) or on a
single tab it excludes every field inside it.

### Entry points

- `@runroom/payload-plugin-translator`: `translatorPlugin`, `translatorTranslations`,
  `ProviderError`, `isTranslatorWrite`, `TRANSLATOR_WRITE_CONTEXT`, `RECORDS_SLUG`,
  `TRANSLATE_TASK_SLUG`, and the types `TranslatorPluginOptions`,
  `TranslatorEntityOptions`, `TranslationProvider`, `TranslateRequest`,
  `TranslatorAccess`, `TranslatorAccessOperation`, `OnLiveWrite`, `EntityRef`,
  `StatusResponse` and `LocaleStatus`.
- `@runroom/payload-plugin-translator/openai`: `openAIProvider` and the type
  `OpenAIClientLike`. Kept apart so `openai` stays an optional dependency.
- `@runroom/payload-plugin-translator/testing`: `fakeProvider`, kept out of the main entry
  so test code does not ship with it.
- `@runroom/payload-plugin-translator/client`: `TranslateControl`, the admin component the
  plugin registers (you do not import it yourself).

### Providers

- `openAIProvider({ apiKey, model, client? })` uses the OpenAI Responses API with a strict
  JSON schema, a 60 s timeout and one SDK retry. Refusals, content-filter cuts, an
  exhausted quota (`insufficient_quota`) and 400/401/403/404/422 errors are not retried; a
  response cut by `max_output_tokens`, a 429, a 5xx or a network error is.
- `fakeProvider({ delayMs? })` (from `/testing`) prefixes every value with `[<locale>] `.
  Meant for tests and E2E runs without an API key.
- A custom provider implements
  `{ translate({ sourceLocale, targetLocale, instructions, units }) }` and returns an
  object with exactly the same keys as `units`. Values may contain numbered tags
  (`<1>…</1>`, `<2/>`) that must be kept unchanged, and the entities `&lt;` and `&amp;`,
  which must be kept as they are. Throw `new ProviderError(message, retryable)` to tell
  the job whether retrying makes sense. Units are sent in batches of up to 40 values or
  12,000 characters.

## Permissions

Two layers decide who can translate a document:

1. **The plugin's `access`**, called as `access({ req, ref, operation })`, where
   `operation` is `'translate'` (`POST /translate`) or `'status'` (`GET /status`) and
   `ref` is `{ entityType, collectionSlug, docId }` (absent when the status query has no
   valid entity). The endpoints are custom endpoints, outside Payload's collection access
   control, so put every check you need here (a role, a second factor…). When it returns
   `false` the endpoints answer 403.
2. **The document's own access**, evaluated with the request's user exactly as the admin
   does (`docAccessOperation`, including `access` functions that return a `where`):
   without **read** permission the document does not exist for the requester (404 on both
   endpoints); without **update** permission `POST /translate` answers 403, since
   translating writes to the document (and, without drafts, publishes it).

The `translation-records` collection is hidden in the admin and **closed over REST and
GraphQL**: `read`, `create`, `update` and `delete` are always denied. A record names a
document and keeps its errors, so reading it goes through `GET /status`, which checks both
the plugin's `access` and the document's own. Only the plugin, through the Local API,
reads and writes it.

The job writes through the **Local API with its default `overrideAccess`** and **without a
user**, because it runs outside the request that queued it; the permission checks above
happen before queueing. The requesting user's field-level **read and update** permissions
are snapshotted when the job is queued; fields missing either permission are not sent to
the provider, written, or counted in status, and their previous fingerprints are kept.
Every write it makes to your documents carries its own request `context`
(`TRANSLATOR_WRITE_CONTEXT`); use `isTranslatorWrite(context)` in your hooks to tell its
writes apart, for example to skip revalidating the public site on a draft write, or to
keep a sync from claiming a field the translator wrote.

## Endpoints

### `POST /api/translator/translate`

```jsonc
{
  // a collection document...
  "collection": "pages",
  "id": "6650f1c2…",
  // ...or a global instead: "global": "footer"
  "sourceLocale": "en", // required: the locale open in the admin
  "targetLocales": ["es", "ca"], // required: the locales to translate into
  "overwriteEdited": false, // optional, see "No-overwrite rule"
}
```

The checks run in this order:

| Status | Body                                                    | When                                                                                                                                       |
| ------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 400    | `{ "error": "bad-request" }`                            | The body is not JSON or lacks `collection` + `id` (or `global`), `sourceLocale` or the `targetLocales` array. Checked before `access`.     |
| 403    | `{ "error": "forbidden" }`                              | The plugin's `access` denies it.                                                                                                           |
| 503    | `{ "error": "not-configured" }`                         | `provider` is `null`.                                                                                                                      |
| 400    | `{ "error": "bad-request" }`                            | The collection is not configured, `sourceLocale` is not one of the entity's locales, or no target is a valid locale other than the source. |
| 404    | `{ "error": "not-found" }`                              | The global is not configured, the document or global does not exist, or the user cannot read it.                                           |
| 403    | `{ "error": "forbidden" }`                              | The user cannot update the document or global.                                                                                             |
| 409    | `{ "error": "busy", "busy": ["es"] }`                   | A locale of the document is already queued or translating. The lock is per document, not per locale.                                       |
| 500    | `{ "error": "records-failed", "queued": ["es", "ca"] }` | The job was queued and started, but the records could not be set to `queued`, so the document may not show as locked.                      |
| 202    | `{ "queued": ["es", "ca"] }`                            | The job was queued and started.                                                                                                            |

Targets that are not locales of the entity, and the source itself, are dropped as long as
one valid target remains.

### `GET /api/translator/status`

`?collection=pages&id=6650f1c2…` or `?global=footer`. Answers 403 when the plugin's
`access` denies it and 404 when the entity is not configured, does not exist or the user
cannot read it. Otherwise 200 with:

```ts
type StatusResponse = {
  enabled: boolean // false when `provider` is null: the admin hides the control
  writesLive: boolean // true for entities without drafts
  // date of the latest published version; null without drafts or if never published
  lastPublishedAt: string | null
  locales: LocaleStatus[] // one per locale of the entity, in config order
}

type LocaleStatus = {
  locale: string
  state: 'none' | 'queued' | 'running' | 'done' | 'failed'
  sourceLocale: string | null // locale it was last translated from
  stale: boolean // `changed > 0 || missing > 0`, only measured for `done`
  changed: number // fields changed in the source since the last translation
  missing: number // fields with text in the source that are empty in this locale
  error: string | null
  translatedAt: string | null // last time the job actually wrote something
  kept: number // texts left untouched because they were edited by hand
}
```

A record left `queued` or `running` without updates for 15 minutes (a process that died
mid-job) stops locking the document and is reported as `state: 'failed'` with the error
`The translation was interrupted before it finished; you can start it again`. That is
decided on read: `/status` never changes a record's state.

## How it works

### Admin UI

A "Translate" button is added to the document controls of every configured collection
(`admin.components.edit.beforeDocumentControls`) and global
(`admin.components.elements.beforeDocumentControls`). It opens a drawer titled "Translate
from {open locale}" listing the other locales with their state (not translated, up to
date, out of date, queued, translating, draft ready / published, error), where each was
translated from and when, the fields changed in its source and the fields empty in the
target. A notice in the controls bar reports the state of the open locale (translating,
ready to reload, out of date, failed, unpublished draft). While a translation runs, the
control polls `/status` every 2 seconds.

### Translating from the open locale

The locale open in the admin is the source and the others are the targets. The state of
each locale is measured against the locale it was last translated _from_, not against the
open one, and translating a locale from a different source changes its source. A record
without `sourceLocale` is measured against the default locale.

### No-overwrite rule and `overwriteEdited`

The translator only writes a target field that is empty or still holds its own last
output, whatever the target locale. Text written by anyone else (an editor's correction,
an import) counts as edited by hand and is kept; the drawer reports how many texts were
kept. The "Also overwrite texts edited by hand" option (`overwriteEdited: true`) is the
only way to force it, and it only affects those kept fields: fields already up to date are
not translated again.

### Fingerprints

The `translation-records` collection keeps, per entity and target locale, two fingerprints
of every translated field: one of the source text it was translated from and one of the
output as Payload saved it (after your `beforeChange` hooks). They decide what is up to
date, what changed in the source and what was edited by hand. Fingerprints follow array
and block row ids, so reordering rows does not make a translation stale. A field emptied
in the source keeps its fingerprints, so filling it again does not turn the old
translation into "edited by hand".

### Drafts vs direct writes

The mode follows each entity's `versions.drafts`. With drafts the job writes with
`draft: true`: the published version is untouched until an editor publishes. Without
drafts there is nowhere to leave a pending translation, so the job writes the document
directly and it is live at once; `/status` reports it as `writesLive: true` and the drawer
warns before translating. Everything else (re-reading the target right before writing,
verifying after the write, fingerprints) works the same in both modes.

### Jobs

`POST /translate` queues one `translateDocument` job per document with every target locale
and runs it right away, filtered by the queued job's id. The locales are translated in
sequence inside that job, because each write saves the whole document from the latest
version. Non-recoverable errors (a provider error marked as not retryable, broken
formatting, a missing document, a validation error) cancel the job; the rest are retried
twice with exponential backoff (10 s base). A retry goes through every locale again, but
the finished ones come out unchanged thanks to their fingerprints, so no provider call or
write is repeated.

### Live writes and `onLiveWrite`

The job runs after the HTTP response, outside any request, where framework helpers such as
Next's `revalidatePath` are lost or throw. So **the job never calls `onLiveWrite`**: it is
called from **`GET /status`**, once per finished translation of an entity without drafts,
with `{ req, entityType, slug, docId, locales }` (`docId` is `null` for globals). The
admin control polls `/status` until the translation ends, so in practice it fires as soon
as the editor's admin sees the translation finish. **If nobody requests `/status` for that
document after the job ends (the editor closed the tab, the job was retried by a cron
later), the hook does not fire until someone does.** Errors in the hook are caught and
logged as warnings, and the translation is marked as notified anyway, so a failing hook is
not retried on every poll.

### Lexical rich text

Each paragraph-like node (a node whose children are all inline) is sent to the model as
one string where every inline node becomes a numbered mark (`<1>bold</1>`, `<2/>` for a
line break or an inline block), and the result is parsed back into the same nodes.
Formatting, links, uploads and **the content of blocks and inline blocks are not
translated: they are copied from the source**. Changes to those parts in the source still
make the target stale, because they are part of the fingerprint. A rich text with no text
at all (only uploads, blocks or rules) is copied to the target as is, without a provider
call. A translation that breaks the marks, or comes back blank for a non-blank value, is
retried once for the broken values and then fails the locale. Literal mark-like text in
your content (`Age <18>`) is sent with `&lt;` entities so the model cannot confuse it with
a mark; plain `text` and `textarea` fields are not checked for marks.

### Admin languages

The plugin ships its admin strings in **English and Spanish** under the `translator`
namespace. Every other admin language (from `i18n.supportedLanguages` or
`i18n.translations`) falls back to English. Your own `i18n.translations` always win, so
you can override single strings or add a language:

```ts
import { de } from '@payloadcms/translations/languages/de'
import { en } from '@payloadcms/translations/languages/en'

export default buildConfig({
  i18n: {
    supportedLanguages: { en, de },
    translations: {
      // keys you leave out fall back to English
      de: { translator: { translate: 'Übersetzen', submit: 'Übersetzen' } },
      // or tweak a shipped string
      en: { translator: { translate: 'Translate with AI' } },
    },
  },
  // ...
})
```

`translatorTranslations` (exported from the root entry) holds the shipped catalogs:
`translatorTranslations.en.translator` lists every key.

Server-side messages (the errors stored in the records and shown in the drawer, log lines,
startup errors) are in English. The records collection labels are in English and Spanish;
the task label is in English.

## Known limitations

- **Localized containers are not supported.** An `array`, `blocks`, `group` or named tab
  with `localized: true` in a configured entity makes the plugin throw at startup, as does
  a configured slug that does not exist or a `locales` list that is not in `localization`
  or has fewer than two locales.
- **The admin UI is coupled to Payload 3.90.** It relies on internal admin CSS classes of
  `@payloadcms/ui` (`drawer__*`, `btn--*`) and its theme tokens, on its `Drawer`, `Button`
  and `useDocumentInfo`, and on where 3.90 renders `beforeDocumentControls`. That is why
  the peer range starts at `^3.90.2`; a later minor may need adjustments.
- **A concurrent edit can overwrite a translation.** Payload does not merge locales
  atomically: an autosave in another locale that lands while the job writes can wipe what
  was translated. The job re-reads the target after writing and fails with a retryable
  error when it does not match. Likewise, an editor who keeps the target locale open and
  saves without reloading overwrites the translation; the control asks them to reload.
- **`localizeStatus` is not supported** by the "unpublished draft" notice, which relies on
  the document-level publish status and the latest published version.
- **Fixed names.** The records collection is always `translation-records`, the endpoints
  `/api/translator/translate` and `/api/translator/status`, and the task
  `translateDocument`; they cannot be renamed, so they must not clash with yours.

## Development

```bash
pnpm install
pnpm test            # vitest (node; jsdom for the admin component tests)
pnpm lint            # oxlint (type-aware) + oxfmt --check + tsc
pnpm fix:lint
pnpm build           # dist/: swc for JS, tsc for declarations, CSS copied
pnpm check:package   # publint + arethetypeswrong on the packed package
```

`exports` point at `dist/`: `prepare` builds it when the package is installed from git and
`prepack` rebuilds it before packing. A `dev/` Payload app to try the plugin end to end
(as in Payload's plugin template) is still to be added.

## License

MIT © Runroom
