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

## Conformance

Build the packages and run the language-neutral harness from a sibling `odp-specs` checkout:

```sh
pnpm build
pnpm conformance --specs-dir ../odp-specs
```

The harness writes separate Agent and Service reports to `.conformance/reports`. A skipped case
means the shared vector does not map to an independently callable public Node.js operation; it is
not a conformance claim. Continuous integration checks out the current `odp-specs` default branch,
runs both roles on Node.js 22 and 24, and uploads the Node.js 22 reports as the
`odp-node-conformance` artifact.

## Releases

Published package changes require a Changeset. The release workflow maintains a version pull
request and publishes approved versions to npm with provenance. Each package must have npm Trusted
Publishing configured for `offering-protocol/odp-node` and `.github/workflows/release.yml` before
its first publication.
