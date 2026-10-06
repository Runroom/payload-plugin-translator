# Changelog

## 0.1.0

First release, extracted from the AI content translator built for a Payload 3.90 project.

- `translatorPlugin` translates localized `text`, `textarea` and Lexical `richText` fields
  of collections and globals from the locale open in the admin into the others: as drafts
  when the entity has them, written directly when it does not.
- Never overwrites text it did not write unless the editor asks for it.
- Admin control with per-locale state (stale, changed and empty fields), retries and
  notices; endpoints `POST /api/translator/translate` and `GET /api/translator/status`.
- `translation-records` collection and `translateDocument` job task.
- Providers: `openAIProvider` (`/openai` entry, optional `openai` peer) and
  `fakeProvider`.
