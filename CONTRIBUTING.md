# Contributing

Thanks for helping. Bug reports, fixes and small improvements are welcome; for a larger
change or a new option, open an issue first so we can agree on the approach before you
spend time on it.

## Setup

You need Node 22.12 or later and pnpm (the version is pinned in `package.json`, so
`corepack enable` picks it up).

```bash
pnpm install
pnpm test     # unit tests plus integration tests against a real Payload (SQLite)
pnpm lint     # oxlint, oxfmt --check and tsc
```

`pnpm fix:lint` formats and applies the safe lint fixes. `pnpm build` and
`pnpm check:package` check the published package.

## Layout

- `src/core/`: pure logic (schema walking, fingerprints, Lexical serialization, the
  translation plan). No Payload runtime calls.
- `src/provider/`: the `TranslationProvider` interface and its adapters (OpenAI, fake).
- `src/server/`: everything that talks to Payload (endpoints, the job, records, status).
- `src/ui/`: the admin control (React client components).
- `src/shared/`: the HTTP contract shared by the endpoints and the admin control.
- `src/plugin/` and `src/plugin.ts`: option validation and the Payload config changes.
- `dev/payload.config.ts`: the Payload config the integration tests boot.

## Pull requests

- Keep each pull request focused on one change, with tests for the behavior it adds or
  fixes. `pnpm lint` and `pnpm test` must pass; CI runs them on Node 22 and 24.
- If the change affects people who install the package (a feature, a fix, a breaking
  change), add a changeset with `pnpm changeset` and describe it from the user's side.
  Refactors, tests, docs and CI changes do not need one.
- Update `README.md` when you change an option, an endpoint or a documented behavior.

## Reporting a vulnerability

Do not open a public issue; follow [SECURITY.md](./SECURITY.md).
