# Offering Discovery Protocol for Node.js

[![CI](https://github.com/offering-protocol/odp-node/actions/workflows/ci.yml/badge.svg)](https://github.com/offering-protocol/odp-node/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Official TypeScript and Node.js packages for the
[Offering Discovery Protocol](https://www.offeringprotocol.org/).

ODP separates directory discovery from Service catalog discovery. An Agent finds candidate Services
through the canonical directory, inspects each Service document, and then navigates or searches that
Service's Collections and Offerings.

## Packages

| Package                                                          | Responsibility                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| [`@offering-protocol/core`](./packages/core/README.md)           | Protocol types, validation, errors, pagination, and HTTP contracts.  |
| [`@offering-protocol/directory`](./packages/directory/README.md) | Canonical production and sandbox directory client.                   |
| [`@offering-protocol/agent`](./packages/agent/README.md)         | Directory-to-Service discovery and Agent-oriented catalog workflows. |
| [`@offering-protocol/service`](./packages/service/README.md)     | Service document and catalog-operation integration helpers.          |

Dependencies flow from role packages toward `core`; `agent` composes `directory`. `core` does not
depend on another ODP package, and `service` does not depend on Agent or directory behavior.

## Development

This repository uses pnpm workspaces and Turborepo. Node.js 22 is the supported runtime floor, and
continuous integration also tests Node.js 24.

```sh
pnpm install
pnpm verify
```

See [DEVELOPMENT.md](./DEVELOPMENT.md) for the repository workflow and
[`odp-specs`](https://github.com/offering-protocol/odp-specs) for the authoritative protocol.

## License

MIT.
