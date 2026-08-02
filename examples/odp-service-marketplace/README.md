# Marketplace ODP Service

This example shows storage-backed handler boundaries without allocating a marketplace catalog in
memory. It generates bounded pages over a virtual ten-million-Offering catalog, supports Offering
search, retrieves individual Offerings, and carries search state in opaque stateless continuations.

Enter the example directory, copy the configuration template, and run the example:

```sh
cd examples/odp-service-marketplace
cp .env.example .env
pnpm build
pnpm start
```

The checked-in `.env.example` selects `http://127.0.0.1:4102`; `PORT` is required. Startup output
identifies the Service document and ODP endpoint base; each request logs its method, path, and
response status.
