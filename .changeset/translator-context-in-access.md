---
'@runroom/payload-plugin-translator': minor
---

The translator's access checks and reads now carry `TRANSLATOR_WRITE_CONTEXT`, as its
writes already did, so a field's `access` can let the translator fill a localized field
people may not edit with `isTranslatorWrite(req.context)`.
