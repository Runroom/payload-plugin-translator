---
'@runroom/payload-plugin-translator': patch
---

A field the requester may update but not read in the target locale is no longer translated
again on every run, reported as kept and shown as pending: the target is now compared as
Payload stored it.
