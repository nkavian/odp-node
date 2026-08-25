# AEP and MPP protected ODP Action

This Service publishes a public ODP catalog containing a report Offering. The Offering's `purchase`
Action points to `GET /actions/report`, which requires AEP API-key authentication before presenting
an MPP payment challenge for 0.01 USDC. ODP advertises both protocols, but the live HTTP challenges
control authentication and payment. The MPP descriptor advertises InFlow as an accepted payment
option.

## Run

### Prerequisite

This example requires an InFlow **Seller** account and an API key created in its sandbox dashboard:

- [Sandbox registration](https://sandbox.inflowpay.ai) for testing

Start the ephemeral AEP Platform, which serves the Service DID used by this example:

```sh
pnpm --filter @aep-foundation/example-aep-platform-ephemeral start
```

Run that command from an `aep-node` checkout. Its
[`aep-platform-ephemeral`](https://github.com/aep-foundation/aep-node/tree/main/examples/aep-platform-ephemeral)
README describes the local identity service.

Copy `.env.example` to `.env`, set `INFLOW_API_KEY` and `MPP_SECRET_KEY`, then build and start the
example:

```sh
pnpm build
pnpm --filter @offering-protocol/example-service-aep-mpp start
```

The default Service origin is `http://127.0.0.1:4103`. Inspect the ODP document and Offering before
invoking its Action:

```sh
curl http://127.0.0.1:4103/.well-known/odp
curl http://127.0.0.1:4103/odp/offerings/report
```

The InFlow command-line interface handles AEP before MPP:

```sh
inflow mpp pay http://127.0.0.1:4103/actions/report --format json
```

An anonymous Action request returns the AEP challenge. After enrollment and Grant, the request
returns the MPP challenge. The paid replay carries both credentials and returns the report.
