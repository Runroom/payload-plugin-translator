# Changesets

Every pull request that changes what users get (features, fixes, breaking changes) adds a
changeset:

```bash
pnpm changeset
```

Pick the bump (`patch`, `minor` or `major`) and write one or two sentences for the
changelog. Commit the generated `.changeset/*.md` file with the rest of the change.
Refactors, tests and CI changes do not need one.

On every push to `main`, the release workflow either opens a "Version Packages" pull
request with the pending changesets applied to `package.json` and `CHANGELOG.md`, or, once
that pull request is merged, publishes the new version to npm.
