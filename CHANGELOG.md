# @runroom/payload-plugin-translator

## 0.1.0

First release.

### Added

- `translatorPlugin`, which translates localized `text`, `textarea` and Lexical `richText`
  fields of collections and globals, including inside arrays, groups, tabs and blocks,
  from the locale open in the admin into the entity's other locales: as drafts when the
  entity has them, written directly when it does not.
- A no-overwrite rule backed by per-field fingerprints: text the translator did not write
  is kept unless the editor asks to overwrite it (`overwriteEdited`).
- An admin control with per-locale state (out of date, changed and empty fields, errors,
  unpublished drafts), retries and notices, in English and Spanish, with English as the
  fallback for any other admin language; `translatorTranslations` exports the catalogs.
- Endpoints `POST /api/translator/translate` and `GET /api/translator/status`, guarded by
  the plugin's `access`, the document's own read and update access, and field-level read
  and update access for translated fields.
- The `translation-records` and `translation-locks` collections and the
  `translateDocument` job task, with retries and an atomic per-document lock. The job acts
  as the requester, with the auth strategy that authenticated them, so access rules that
  check it (a second factor, an API key) decide as they did in the request.
- `onLiveWrite`, to revalidate the public site after a translation of an entity without
  drafts.
- `isTranslatorWrite` and `TRANSLATOR_WRITE_CONTEXT`, to recognise the translator in hooks
  and in a field's `access`: its access checks, reads and writes all carry that context,
  so a field people may not edit can stay open to the translator.
- Providers: `openAIProvider` (`/openai` entry, optional `openai` peer) and `fakeProvider`
  (`/testing` entry, for tests and E2E runs).

[0.1.0]: https://github.com/Runroom/payload-plugin-translator/releases/tag/v0.1.0
