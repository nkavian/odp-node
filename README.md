# Offering Discovery Protocol for Node.js

[![CI](https://github.com/offering-protocol/odp-node/actions/workflows/ci.yml/badge.svg)](https://github.com/offering-protocol/odp-node/actions/workflows/ci.yml)
[![Codecov](https://codecov.io/gh/offering-protocol/odp-node/graph/badge.svg)](https://codecov.io/gh/offering-protocol/odp-node)
[![npm](https://img.shields.io/npm/v/@offering-protocol/agent?label=npm)](https://www.npmjs.com/package/@offering-protocol/agent)
[![node](https://img.shields.io/node/v/@offering-protocol/agent)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6%2B-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Official TypeScript software development kits for the
[Offering Discovery Protocol](https://www.offeringprotocol.org/)—the open protocol for discovering
Services and navigating their Offerings.

ODP separates Service discovery from catalog discovery. An Agent searches the canonical directory
for candidate Services, inspects each Service's live ODP document, and then navigates or searches
that Service's Collections and Offerings. Full Offering details can describe structured attributes,
price previews, and executable Actions without forcing every industry into one product schema.

```text
Agent                                 Canonical Directory                   Service
  │                                     │                                     │
  ├── Search Services ─────────────────▶│                                     │
  │◀── Cached Service metadata ─────────┤                                     │
  │                                     │                                     │
  ├── Inspect /.well-known/odp ──────────────────────────────────────────────▶│
  │◀── Operations and protocol capabilities ──────────────────────────────────┤
  │                                     │                                     │
  ├── Search or navigate Offerings ──────────────────────────────────────────▶│
  │◀── Terse results and full details ────────────────────────────────────────┤
  │                                     │                                     │
  ├── Invoke an explicitly selected Action ──────────────────────────────────▶│
  │◀── Live AEP, MPP, x402, or application response ──────────────────────────┤
```

## Start Here

Choose the role you are implementing:

| I am building…                             | Start with                                                       | What it provides                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| An Agent, command-line tool, or automation | [`@offering-protocol/agent`](./packages/agent/README.md)         | Directory-to-Service search, catalog navigation, enrichment, and Action discovery  |
| A Service with an ODP catalog              | [`@offering-protocol/service`](./packages/service/README.md)     | Service document, fixed routes, static catalogs, and storage-backed handlers       |
| A canonical-directory integration          | [`@offering-protocol/directory`](./packages/directory/README.md) | Production or sandbox Service search with bounded lazy pagination                  |
| An ODP implementation or validation tool   | [`@offering-protocol/core`](./packages/core/README.md)           | Protocol models, bundled schemas, validation, identity, references, and pagination |

All packages are ESM-first, support Node.js 22 or newer, and publish under the
`@offering-protocol` npm scope.

## Install

```sh
# Agent-side discovery and catalog workflows
pnpm add @offering-protocol/agent

# Service integration
pnpm add @offering-protocol/service

# Canonical directory access without the Agent orchestration layer
pnpm add @offering-protocol/directory
```

Use `npm install` or `yarn add` if those are the package managers in your application.

## Agent Workflow

`createOdpAgent` searches the canonical directory and then searches the live catalogs of matching
Services. Directory results never pretend to contain complete Service catalogs.

```ts
import { createOdpAgent } from "@offering-protocol/agent";

const agent = createOdpAgent({ environment: "sandbox" });

for await (const event of agent.searchOfferingsAcrossServices({
  services: { filters: { keywords: ["gpu"] } },
  offerings: { filters: [{ id: "region", operator: "eq", value: "us-west" }] }
})) {
  if (event.type === "offering") useOffering(event.service, event.offering);
  else reportServiceIssue(event.service, event.issue);
}
```

For one known Service, `createOdpServiceClient` exposes lazy Collection and Offering traversal,
structured search, full-detail enrichment, and Action resolution. Applications can inject a
payment- or enrollment-aware transport while keeping the ODP client independent of those protocol
implementations.

## Service Workflow

The minimum Service integration publishes `/.well-known/odp`, lists Offerings, and retrieves one
Offering. `createStaticCatalog` derives the advertised operations from its configured resources.

```ts
import { createOdpService, createStaticCatalog } from "@offering-protocol/service";

const odp = createOdpService({
  document: {
    description: "On-demand compute resources",
    http: { endpoint_base: "/odp" },
    language: "en",
    localizations: ["en"],
    name: "Example Compute"
  },
  catalog: createStaticCatalog({
    offerings: [
      {
        id: "gpu-h100",
        name: "H100 GPU",
        odp_version: "1.0",
        price: { amount: "2.50", currency: "USD", type: "starting_at" }
      }
    ]
  })
});

const response = await odp.fetch(request);
```

Large catalogs implement storage-backed handlers instead. The Service package passes bounded,
validated requests to the application and does not load, copy, sort, or index the complete catalog.

## Packages

| Package                                                          | npm                                                                                                                             | Responsibility                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`@offering-protocol/agent`](./packages/agent/README.md)         | [![npm](https://img.shields.io/npm/v/@offering-protocol/agent)](https://www.npmjs.com/package/@offering-protocol/agent)         | Directory-to-Service discovery and Agent-oriented catalog workflows          |
| [`@offering-protocol/core`](./packages/core/README.md)           | [![npm](https://img.shields.io/npm/v/@offering-protocol/core)](https://www.npmjs.com/package/@offering-protocol/core)           | Protocol types, validation, identity, errors, pagination, and HTTP contracts |
| [`@offering-protocol/directory`](./packages/directory/README.md) | [![npm](https://img.shields.io/npm/v/@offering-protocol/directory)](https://www.npmjs.com/package/@offering-protocol/directory) | Canonical production and sandbox directory client                            |
| [`@offering-protocol/service`](./packages/service/README.md)     | [![npm](https://img.shields.io/npm/v/@offering-protocol/service)](https://www.npmjs.com/package/@offering-protocol/service)     | Service document, catalog operations, and integration helpers                |

Dependencies flow from role packages toward `core`; `agent` composes `directory`. `core` does not
depend on another ODP package, and `service` does not depend on Agent or directory behavior.

## Runnable Flows

The examples cover both minimum integrations and marketplace-scale catalogs. The mock directory
includes only Services that are reachable when the Agent starts.

| Layer              | Examples                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Public Services    | [`small catalog`](./examples/odp-service-small/README.md) · [`marketplace catalog`](./examples/odp-service-marketplace/README.md) |
| Protected Services | [`AEP then MPP`](./examples/odp-service-aep-mpp/README.md) · [`x402`](./examples/odp-service-x402/README.md)                      |
| Agent              | [`two-stage discovery`](./examples/odp-agent-discovery/README.md)                                                                 |

Build and run the public discovery flow:

```sh
pnpm install
pnpm build
pnpm smoke:examples
```

For an interactive walkthrough, start any of the Service examples and then run the Agent example.
See [examples/README.md](./examples/README.md) for the complete map.

## Protocol Composition

ODP advertises AEP enrollment and describes authentication requirements for operations, payment
rails, and Offering Actions. It does not duplicate their credential or payment semantics. A live
challenge from the selected operation or Action remains authoritative.

The Agent software development kit resolves an Action but never invokes it implicitly. The caller
must select the Action and approve any authentication, payment, or state-changing request.

## Production Boundaries

Applications control persistent caching, authentication context, network policy, authorization,
catalog storage, indexing, and Action execution. Service deployments provide their own persistence
and tenant boundaries. The canonical directory is fixed to production or sandbox; callers cannot
configure an alternate directory origin.

## Development

This is a pnpm and Turborepo monorepo. The merge gate is:

```sh
pnpm install
pnpm verify
```

See [DEVELOPMENT.md](./DEVELOPMENT.md) for the contributor workflow and
[`odp-specs`](https://github.com/offering-protocol/odp-specs) for the normative draft, schemas,
examples, and test vectors.

## Security

See [SECURITY.md](./SECURITY.md) for vulnerability reporting. The applications under `examples/`
use illustrative in-memory catalogs and sandbox integrations.

## License

MIT.
