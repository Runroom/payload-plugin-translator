# Changesets

Every pull request that changes what users get (features, fixes, breaking changes) adds a
changeset:

```bash
pnpm changeset
```

Pick the bump (`patch`, `minor` or `major`) and write one or two sentences for the
changelog. Commit the generated `.changeset/*.md` file with the rest of the change.
Refactors, tests and CI changes do not need one.

To release, open a pull request that runs:

```bash
pnpm changeset version
```

It applies the pending changesets to `package.json` and `CHANGELOG.md` and deletes them.
Once that pull request is merged, the release workflow publishes the new version to npm.
While changesets are pending on `main`, it publishes nothing.
