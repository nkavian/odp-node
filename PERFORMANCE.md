# Performance

The release gate measures protocol validation, bounded pagination, the configuration-first static
catalog, and storage-backed Service dispatch through the packages' public APIs.

```sh
pnpm benchmark
```

The command builds the packages, warms each benchmark, prints the observed throughput, and checks
conservative budgets designed to detect material regressions across supported Node.js versions and
GitHub-hosted runners. The budgets are release safeguards rather than hardware-independent claims
about production capacity.

The storage-backed benchmark creates only the requested page. It represents the Service runtime
over an externally indexed catalog; database and network performance remain application concerns.
