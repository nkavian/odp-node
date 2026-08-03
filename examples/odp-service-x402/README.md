# x402 protected ODP Action

This Service publishes a public ODP catalog containing a dataset Offering. The Offering's
`download` Action points to `GET /actions/dataset`, protected by the foundation x402 Express
middleware using InFlow as facilitator. ODP provides the preview and target; the live x402 response
provides the authoritative payment requirements.

## Run

Copy `.env.example` to `.env`, set the sandbox `INFLOW_API_KEY`, then build and start the example:

```sh
pnpm build
pnpm --filter @offering-protocol/example-service-x402 start
```

The default Service origin is `http://127.0.0.1:4104`. Inspect the ODP document and Offering before
invoking its Action:

```sh
curl http://127.0.0.1:4104/.well-known/odp
curl http://127.0.0.1:4104/odp/offerings/dataset
inflow x402 pay http://127.0.0.1:4104/actions/dataset --format json
```

The final command follows the live x402 challenge and returns the paid dataset response.
