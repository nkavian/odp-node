# ODP Agent Discovery

This example performs the two-stage discovery flow against any reachable ODP Services configured in
`.env`.

The directory is explicitly a mock. `src/mock-directory.ts` probes the configured Service URLs,
builds cached directory entries for reachable Services, and samples at most two Collections from
the first page when both Collection listing and detail retrieval are advertised without required
authentication. It implements unfiltered mixed and
Service-only search requests in memory. This bounded sampling seeds example data only: the deployed
Directory indexes explicitly submitted Collections, rather than crawling each Service. The mock
does not contact a deployed directory or implement its filtering, ranking, or suggestion query.

Enter the example directory, copy the configuration template, and run the agent after starting any
of the example Services:

```sh
cd examples/odp-agent-discovery
cp .env.example .env
pnpm build
pnpm start
```

Unreachable URLs are skipped. The example calls `directory.search()` and branches on each result's
`type`. For a Service result, it prints the mock entry, validated ODP Service document, first terse
Offering page, and full details for the first Offering. For a Collection result, it prints the entry,
inspects the owning Service, and fetches the live Collection using that Service and Collection ID.
Unknown result types are reported without contacting their contents. The marketplace example
provides Collections, so run it to exercise both known result types.
