# ODP Service on Cloudflare Workers

Publish an ODP catalog from a Cloudflare Worker using `@offering-protocol/service`. This example
offers one free incident-response template. It serves the Service Document, Offering list, Offering
details, and the advertised download Action.

## Run locally

You need Node.js 22 or newer and pnpm to run the development tools. No Cloudflare account is needed
for local testing. From the repository root:

```sh
pnpm install
pnpm --filter @offering-protocol/service... build
pnpm --filter @offering-protocol/example-service-cloudflare dev
```

Wrangler prints the local address, normally `http://localhost:8787`. Try:

```sh
curl http://localhost:8787/.well-known/odp
curl http://localhost:8787/odp/offerings
curl http://localhost:8787/odp/offerings/incident-plan
curl http://localhost:8787/downloads/incident-plan.txt
```

Edit `src/index.ts` to change the catalog. For a database-backed Service, replace the two catalog
handlers with your application's queries. The ODP handler validates requests and responses and
returns the appropriate HTTP status and headers.

## Use it in your Worker

Install `@offering-protocol/service` in your application, copy the integration from `src/index.ts`,
and configure Wrangler:

```json
{
  "main": "src/index.ts",
  "compatibility_date": "2025-06-01",
  "compatibility_flags": ["nodejs_compat", "disallow_eval_during_startup"]
}
```

`2025-06-01` is the compatibility date tested by this example. Node compatibility provides the URL,
Buffer, and cryptographic APIs used by the SDK. The explicit `disallow_eval_during_startup` flag
demonstrates that ODP's bundled validators do not need permission to generate JavaScript at runtime;
the flag is not required by ODP. See Cloudflare's
[Node compatibility guidance](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) when
choosing a later date for an existing application.

The SDK ships its compiled ODP validators in the npm package. You do not need to generate them or
download schemas when your Worker starts.

This example has no accounts, payments, database, or secrets. Those remain application choices;
adding an ODP catalog does not implement authentication or payments.

If you replace the catalog handlers with `createStaticCatalog`, initialize that helper inside the
Worker request handler and pass a stable `continuationKey` from a Worker secret. Its default random
key cannot be generated during module initialization. Using the same secret across Worker instances
also lets pagination continue when requests reach different instances.

## Test and deploy

From the repository root, build the SDK packages and run the local Worker tests:

```sh
pnpm --filter @offering-protocol/example-service-cloudflare... build
pnpm --filter @offering-protocol/example-service-cloudflare test
```

The tests use Cloudflare's local runtime and do not deploy a Worker. They cover discovery, Offering
retrieval, validation errors, conditional requests, and the download Action. The repository's
`pnpm verify` command also runs them. A Directory compatibility test uses Workers' native `fetch`
with a local response fixture; it does not contact the live Directory.

To deploy, first choose your Worker name in `wrangler.json`. Then authenticate to your Cloudflare
account and publish:

```sh
pnpm --filter @offering-protocol/example-service-cloudflare exec wrangler login
pnpm --filter @offering-protocol/example-service-cloudflare deploy
```

## Calling other Services from Workers

Hosting this catalog does not require the Agent package. If your Worker also needs directory
search, use `@offering-protocol/directory` and start requests inside your request handler.

The full `@offering-protocol/agent` package has additional transport and schema-compilation
requirements. It is not covered by this Service example. Read its
[Workers limitations](../../packages/agent/README.md#cloudflare-workers) before using it in a Worker.
