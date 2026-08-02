# ODP Agent Discovery

This example performs the two-stage discovery flow against any reachable ODP Services configured in
`.env`.

The directory is explicitly a mock. `src/mock-directory.ts` probes the configured Service URLs,
builds cached directory entries only for reachable Services, and implements the sandbox Service-search
request in memory. It does not contact a deployed directory or pretend to be its implementation.

Enter the example directory, copy the configuration template, and run the agent after starting one
or both example Services:

```sh
cd examples/odp-agent-discovery
cp .env.example .env
pnpm build
pnpm start
```

Unreachable URLs are skipped. For each reachable Service, the output narrates and prints the mock
directory entry, validated ODP Service document, first terse Offering page, and full details for the
first Offering.
