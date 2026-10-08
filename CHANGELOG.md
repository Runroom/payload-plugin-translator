# @runroom/payload-plugin-translator

## 0.2.0

### Minor Changes

- [#37](https://github.com/Runroom/payload-plugin-translator/pull/37)
  [`667cc42`](https://github.com/Runroom/payload-plugin-translator/commit/667cc42fc792e81d31d5dbd139639ad60629fa4e)
  Thanks [@SpykeRel04D](https://github.com/SpykeRel04D)! - The translator's access checks
  and reads now carry `TRANSLATOR_WRITE_CONTEXT`, as its writes already did, so a field's
  `access` can let the translator fill a localized field people may not edit with
  `isTranslatorWrite(req.context)`.

### Patch Changes

- [#35](https://github.com/Runroom/payload-plugin-translator/pull/35)
  [`b09dcb8`](https://github.com/Runroom/payload-plugin-translator/commit/b09dcb8ca87a509395200292f885fa32b9db1a97)
  Thanks [@SpykeRel04D](https://github.com/SpykeRel04D)! - A field the requester may
  update but not read in the target locale is no longer translated again on every run,
  reported as kept and shown as pending: the target is now compared as Payload stored it.

- [#36](https://github.com/Runroom/payload-plugin-translator/pull/36)
  [`c399ab7`](https://github.com/Runroom/payload-plugin-translator/commit/c399ab71a66bd956aae4451d0bd275c060bd4d07)
  Thanks [@SpykeRel04D](https://github.com/SpykeRel04D)! - A translation job now acts with
  the auth strategy that authenticated the requester, instead of always `local-jwt`, so
  access rules that check it (a second factor, an API key) no longer fail every
  translation with "Access denied".

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
  `translateDocument` job task, with retries and an atomic per-document lock.
- `onLiveWrite`, to revalidate the public site after a translation of an entity without
  drafts.
- `isTranslatorWrite` and `TRANSLATOR_WRITE_CONTEXT`, to recognise the translator's writes
  in hooks.
- Providers: `openAIProvider` (`/openai` entry, optional `openai` peer) and `fakeProvider`
  (`/testing` entry, for tests and E2E runs).

[0.1.0]: https://github.com/Runroom/payload-plugin-translator/releases/tag/v0.1.0
