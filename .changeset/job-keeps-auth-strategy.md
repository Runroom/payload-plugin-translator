---
'@runroom/payload-plugin-translator': patch
---

A translation job now acts with the auth strategy that authenticated the requester,
instead of always `local-jwt`, so access rules that check it (a second factor, an API key)
no longer fail every translation with "Access denied".
