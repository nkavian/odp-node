# AGENTS.md

## Repository

This pnpm and Turborepo monorepo contains the official Node.js packages for ODP:

- `@offering-protocol/core`: transport-independent protocol primitives.
- `@offering-protocol/directory`: canonical directory client.
- `@offering-protocol/agent`: Agent-side composition.
- `@offering-protocol/service`: Service-side integration.

The normative protocol is maintained in `offering-protocol/odp-specs`. Check that source before
implementing or changing wire behavior.

## Verification

Run `pnpm verify` before merging. It includes publication-surface verification. Package changes
require a Changeset. Public APIs are defined only by package `src/index.ts` barrels.

## Conventions

- Use strict TypeScript and ESM source.
- Do not use `any`, non-null assertions, broad double casts, or `console.*` in package source.
- Import workspace packages through their public package API, never through `src` internals.
- Keep dependency direction aligned with the package responsibilities above.
- Describe current behavior; do not leave speculative or historical comments.
- Keep public APIs small and backed by tests and authoritative protocol behavior.
