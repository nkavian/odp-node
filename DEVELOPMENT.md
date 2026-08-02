# Development

## Verification

Run the complete repository gate before merging:

```sh
pnpm verify
```

The gate formats, typechecks, lints, tests, documents, builds, and verifies the packed publication
surface of every package. Scope an individual task with a Turbo filter when iterating locally.

```sh
pnpm turbo run typecheck --filter=@offering-protocol/core
```

## Releases

Published package changes require a Changeset. The release workflow maintains a version pull
request and publishes approved versions to npm with provenance. Each package must have npm Trusted
Publishing configured for `offering-protocol/odp-node` and `.github/workflows/release.yml` before
its first publication.
