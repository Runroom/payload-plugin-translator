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
- **Something that runs the jobs.** `POST /api/translator/translate` queues a job and, by
  default (`runOnRequest: true`), starts it right away without waiting for it, so the
  translation runs after the response. That needs a **long-lived Node process**
  (`next start`, a container, a VM), where the promise outlives the response. On
  **serverless**, the function can be frozen or killed once the response is sent, after
  Payload has marked the job as `processing`; later runs of the queue skip a processing
  job, so the translation is abandoned until its lock expires (15 minutes) and someone
  requests it again. There, set **`runOnRequest: false`**: the request only queues the job
  (202) and an **external cron** that calls Payload's
  `GET /api/payload-jobs/run?queue=translations` (protected by `jobs.access.run`, which
  defaults to any logged-in user) runs it, or `jobs.autoRun` does where the platform keeps
  it alive.
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
     unique index on `entityType` + `collectionSlug` + `docId` + `targetLocale`, and a
     `lockToken` text field);
   - the `translation-locks` collection (one lock per entity while a translation is queued
     or running, with a unique index on `entityType` + `collectionSlug` + `docId`);
   - the `translateDocument` job task (with its input schema).

   The plugin does not touch `jobs.enableConcurrencyControl`: two jobs for the same
   document never run at once because of the lock, not because of Payload's
   `concurrencyKey`.

   Without the migration on a SQL adapter, the admin keeps sending you back to the login
   screen after a correct password: Payload's locked-documents query references the new
   `translation_locks_id` column and fails
   (`column payload_locked_documents__rels.translation_locks_id does not exist` on
   Postgres).

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
| `runOnRequest` | `boolean`                                                              | `true`           | Whether `POST /translate` runs the job it queued right away, without waiting for it. Set it to `false` on serverless, where the function may be frozen after the response, and let `jobs.autoRun` or an external cron run the queue.   |
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
   does (`docAccessOperation`, including `access` functions that return a `where`), in the
   locales involved: **read** in the source locale and **update** in every target locale.
   Without read permission the document does not exist for the requester (404 on both
   endpoints); without update permission on any target `POST /translate` answers 403,
   since translating writes to the document there (and, without drafts, publishes it).

The `translation-records` collection is hidden in the admin and **closed over REST and
GraphQL**: `read`, `create`, `update` and `delete` are always denied. A record names a
document and keeps its errors, so reading it goes through `GET /status`, which checks both
the plugin's `access` and the document's own. Only the plugin, through the Local API,
reads and writes it.

The job **runs as the requester**: it stores who asked and the auth strategy that
authenticated them (`req.user._strategy`, so rules that require a second factor or reject
API keys decide as in the request), loads that user again on every attempt and reads the
source and writes the target through the Local API with `overrideAccess: false` and that
user. The target is compared as Payload stored it, so a field the requester may update but
not read there still counts as translated; what is read that way only feeds the
comparisons and is never sent to the provider or returned to the requester. The checks
above are repeated when the job runs, per locale (read on the source locale, update on
each target locale), so access rules that depend on `req.locale`, on the user or on the
document are honoured as they stand at that moment, not as they stood when the job was
queued. A user who loses access, or is deleted, before the job runs gets the locale marked
`failed` with "Access denied" (or "The user who requested the translation no longer
exists") and nothing is sent to the provider. Field access is applied by Payload on the
real data: a field the requester may not read in the source locale is never sent to the
provider, and a field they may not update in the target locale (a row-level rule on
`siblingData` or `blockData`, for instance) keeps its value and is listed as kept, without
failing the run; its fingerprints stay as they were, so if it still holds the translator's
earlier output, the status reports it as stale and the next run tries again. Fields
missing either permission at the schema level are not counted in status either, and their
previous fingerprints are kept. `GET /status` reads each source locale as the requester,
compares each target as stored, and checks read access per locale: a locale they cannot
read is reported without comparison data (`stale: false`, `changed: 0`, `missing: 0`), and
the document only answers 404 when none of its locales is readable. Everything the
translator does to your documents as the requester (the access checks of `/translate`,
`/status` and the job, its reads and its writes) carries its own request `context`
(`TRANSLATOR_WRITE_CONTEXT`). Use `isTranslatorWrite(context)` in your hooks to tell its
writes apart, for example to skip revalidating the public site on a draft write, or to
keep a sync from claiming a field the translator wrote. In a field's `access`, it lets the
translator fill a localized field people may not edit, such as one another system owns:

```ts
{
  name: 'label',
  type: 'text',
  localized: true,
  required: true,
  // Locked in the admin and the REST API; the translator may still fill other locales.
  access: { update: ({ req }) => isTranslatorWrite(req.context) },
}
```

`req.context` cannot be set from an HTTP request, so only the Local API (the translator,
or your own code passing that `context`) gets through.

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

| Status | Body                                  | When                                                                                                                                                                                                                         |
| ------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `{ "error": "bad-request" }`          | The body is not JSON or lacks `collection` + `id` (or `global`), `sourceLocale` or the `targetLocales` array. Checked before `access`.                                                                                       |
| 403    | `{ "error": "forbidden" }`            | The plugin's `access` denies it, or the request has no user.                                                                                                                                                                 |
| 503    | `{ "error": "not-configured" }`       | `provider` is `null`.                                                                                                                                                                                                        |
| 400    | `{ "error": "bad-request" }`          | The collection is not configured, `sourceLocale` is not one of the entity's locales, or no target is a valid locale other than the source.                                                                                   |
| 404    | `{ "error": "not-found" }`            | The global is not configured, the document or global does not exist, or the user cannot read it in the source locale.                                                                                                        |
| 403    | `{ "error": "forbidden" }`            | The user cannot update the document or global in one of the target locales.                                                                                                                                                  |
| 409    | `{ "error": "busy", "busy": ["es"] }` | Another request holds the document's lock: a translation is queued or running. The lock is per document, not per locale; `busy` lists the locales with a pending record, or the requested targets when none is recorded yet. |
| 500    | `{ "error": "failed" }`               | The records or the job could not be saved. Nothing was queued and the lock was released, so the request can simply be repeated.                                                                                              |
| 202    | `{ "queued": ["es", "ca"] }`          | The lock was taken, the records set to `queued` and the job queued. It starts right away unless `runOnRequest` is `false`, in which case your queue runner starts it.                                                        |

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

A `queued` or `running` record is reported as such while the document's lock is live (its
heartbeat is under 15 minutes old) or the record itself was updated in the last 15
minutes. Past both (a process that died mid-job) it is reported as `state: 'failed'` with
the error `The translation was interrupted before it finished; you can start it again`.
That is decided on read: `/status` never changes a record's state. The lock expires on the
same schedule (see [Jobs](#jobs)), so the retry the drawer offers goes through.

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

The target is read again right before writing. A field someone edits while the provider is
still translating is kept too, even with `overwriteEdited`: that option covers the edits
that existed when the translation was requested. Translating from a different source
locale than last time re-translates every field that still holds the translator's output,
even when the source text is identical.

### Fingerprints

The `translation-records` collection keeps, per entity and target locale, two fingerprints
of every translated field: one of the source text it was translated from and one of the
output as Payload saved it (after your `beforeChange` hooks). They decide what is up to
date, what changed in the source and what was edited by hand. Each entry also names the
locale its source fingerprint was taken from: a field left out of a run (one the requester
may not touch, or whose write was refused) keeps the provenance of its earlier translation
while the record itself names the locale of the last run, so a later run from any locale
still knows what it is. Fingerprints follow array and block row ids, so reordering rows
does not make a translation stale. A field emptied in the source keeps its fingerprints,
so filling it again does not turn the old translation into "edited by hand".

### Drafts vs direct writes

The mode follows each entity's `versions.drafts`. With drafts the job writes with
`draft: true`: the published version is untouched until an editor publishes. Without
drafts there is nowhere to leave a pending translation, so the job writes the document
directly and it is live at once; `/status` reports it as `writesLive: true` and the drawer
warns before translating. Everything else (re-reading the target right before writing,
verifying after the write, fingerprints) works the same in both modes.

### Jobs

`POST /translate` takes the document's lock, sets the records to `queued`, queues one
`translateDocument` job per document with every target locale and, with `runOnRequest`
(the default), runs it right away, filtered by the queued job's id; with
`runOnRequest: false` it only queues it and `jobs.autoRun` or an external cron runs it.
The locales are translated in sequence inside that job, because each write saves the whole
document from the latest version. Non-recoverable errors (a provider error marked as not
retryable, broken formatting, a missing document, a validation error) cancel the job; the
rest are retried twice with exponential backoff (10 s base). A retry goes through every
locale again, but the finished ones come out unchanged thanks to their fingerprints, so no
provider call or write is repeated.

The lock is a row in `translation-locks` with a unique index per entity, so taking it is a
single atomic insert in the database: of two simultaneous requests for the same document
exactly one gets a 202 and the other a 409, whatever the adapter or the number of
processes. The job carries the lock's token and refreshes the lock (its `updatedAt` is the
heartbeat) at the start of every attempt, before each record it writes, after every
provider batch and right before each document write; a refresh that finds the lock gone
stops the job. The refresh and the take-over of an expired lock go straight through the
database adapter as single conditional statements (by token, and by age for the
take-over), so a heartbeat that lands at any point either keeps the lock or is reported as
lost; there is no window in which a refreshed lock can still be deleted. So what must fit
in the 15-minute window is one provider call with its retries, not the whole job. The lock
is released when the job ends for good (success, cancellation or the last attempt) and
kept while a retry is pending. A lock whose heartbeat is older than 15 minutes (a process
that died mid-job) is taken over by the next request; the old job, if it ever runs again,
is cancelled as `Superseded by a newer translation request` without writing anything, and
a job that loses its lock while translating stops before its next write, without marking
its records failed: they already belong to the newer request. Every record the request or
the job writes carries the lock token (`lockToken`), which is how a retry tells a `failed`
record of its own earlier attempt (not tried again) from one an older job left behind.

For each locale, the document write and the record that keeps its fingerprints are saved
inside one database transaction, so the document never holds the translator's text without
the fingerprints that say so (which would make the next run keep it as a hand edit). The
re-read that verifies the write runs after the commit, outside the transaction: inside it,
it would only ever see the write itself. This needs an adapter with transactions: see
[Known limitations](#known-limitations).

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

This matters for the public site: when a translation finishes with nobody watching the
admin, the cache of your public pages can stay stale until the next status request for
that document. If that matters, also revalidate on a schedule, or from your own
`afterChange` hook, using `isTranslatorWrite(context)` to recognise the translator's
writes (see [Permissions](#permissions)).

**The hook must be idempotent.** Two status polls that overlap (two admin tabs, a slow
hook) can both read the translation as not yet notified and call the hook twice for the
same translation. Revalidating a path twice is harmless; anything that is not (sending an
email, for instance) needs its own guard.

### Untrusted content

The provider is told that the values it receives are content to translate, never
instructions, and to translate any such text literally. That reduces prompt injection but
does not eliminate it: text imported or written by a third party can still try to steer
the model. The output is validated for structure only (same keys, same marks, not blank),
not for meaning. Collections and globals without drafts publish the model's output without
human review, so use drafts for content from untrusted sources. A custom provider should
treat `units` as data in the same way.

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
  was translated. The job re-reads the target after its write is committed (outside the
  transaction, where a save that waited on the row locks is visible), keeps the
  fingerprints of the fields that survived, drops the rest and fails with a retryable
  error; the retry translates the reverted fields again or, if an editor's text landed,
  keeps it as a hand edit. A save that lands after that re-read is a plain later edit and
  is not detected. Likewise, an editor who keeps the target locale open and saves without
  reloading overwrites the translation; the control asks them to reload.
- **`localizeStatus` is not supported** by the "unpublished draft" notice, which relies on
  the document-level publish status and the latest published version.
- **Atomic write + fingerprints needs transactions.** The document write and its record
  are committed together only when the database adapter supports transactions: Postgres
  does; MongoDB needs a replica set; `@payloadcms/db-sqlite` only runs them when its
  `transactionOptions` is set (off by default, and libsql runs every transaction on its
  own connection, so concurrent writes can fail with `SQLITE_BUSY`). Without transactions
  Payload makes them no-ops: the write and the record are saved one after the other, and a
  record save that fails right after the write leaves text the next run keeps as edited by
  hand until `overwriteEdited` is used.
- **On serverless, a job started by the request can be abandoned.** With
  `runOnRequest: true` (the default) the request starts the job without awaiting it; a
  function frozen or killed after the response leaves the job marked `processing`, which
  every later run of the queue skips, and its lock live. Nothing is lost for good: after
  15 minutes without a heartbeat (`BUSY_WINDOW_MS`) the lock expires, `/status` reports
  the locales as interrupted and a new request takes the document over. To avoid the wait,
  set `runOnRequest: false` there and run the queue from a cron (see
  [Requirements](#requirements)).
- **`onLiveWrite` depends on a status request.** It runs from `GET /status`, not from the
  job. If nobody has the admin open when a translation finishes (a closed tab, a cron
  retry overnight), it does not run until the next status request for that document, and
  the public cache can stay stale until then. Revalidate also on a schedule or from your
  own `afterChange` hook with `isTranslatorWrite(context)`.
- **Prompt injection is reduced, not eliminated.** See
  [Untrusted content](#untrusted-content).
- **`onLiveWrite` may run more than once** for the same translation when two status polls
  overlap; see [Live writes and `onLiveWrite`](#live-writes-and-onlivewrite).
- **Fixed names.** The records collection is always `translation-records` (with its
  `lockToken` field), the locks collection `translation-locks`, the endpoints
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
`prepack` rebuilds it before packing. `dev/payload.config.ts` is a minimal Payload config
with the plugin installed (SQLite in a temp file, Lexical, `en`/`es`/`fr`, the fake
provider). The integration tests in `tests/integration/` boot it with the Local API and
run real translations through the endpoints and the jobs queue, so a Payload upgrade that
breaks what the plugin relies on fails `pnpm test`.

### Releasing

Releases go through [Changesets](https://github.com/changesets/changesets). A pull request
that changes what users get adds a changeset with `pnpm changeset` (see
`.changeset/README.md`). To release, run `pnpm changeset version` on a branch: it applies
the pending changesets to `package.json` and `CHANGELOG.md`. Merging that pull request
makes the `Release` workflow publish the new version to npm with provenance and create the
git tag and GitHub release. Nobody publishes from a local machine.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). To report a vulnerability, follow
[SECURITY.md](./SECURITY.md).

## License

MIT © Runroom
