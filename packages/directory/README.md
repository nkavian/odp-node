# `@offering-protocol/directory`

The official client for canonical Offering Discovery Protocol Service discovery.

## Install

```sh
npm install @offering-protocol/directory
```

The package has two environments and no configurable base URL:

- `createDirectoryClient()` uses `https://api.inflowpay.ai`.
- `createDirectoryClient({ environment: "sandbox" })` uses
  `https://sandbox.inflowpay.ai`.

A fetch-compatible `transport` can be injected for testing without changing the selected origin.

## Search for Services

Directory search covers cached Service metadata, not Service catalogs. Filter values within one
category use OR semantics; different categories combine with AND semantics. The initial page can
include facets for keywords, enrollment protocols, payment protocols, individual protocol payment
options, and ODP operation descriptors.

```ts
import { createDirectoryClient } from "@offering-protocol/directory";

const directory = createDirectoryClient();
const results = directory.searchServices({
  query: "GPU compute",
  filters: {
    keywords: ["gpu", "accelerator"],
    payments: [{ authentication: "not-required", name: "mpp", options: ["inflow", "solana"] }]
  },
  limit: 25
});

for await (const service of results.items) {
  useService(service.service_origin);
}
```

Options within one payment filter are alternatives. The example matches Services that accept either
InFlow or Solana through MPP. A protocol-only `{ name: "mpp" }` filter matches any Service that
advertises MPP. Responses keep protocol counts in `facets.payments` and expose singular
protocol-option counts in `facets.payment_options`.

`items` and `pages` are independent lazy traversals. Each begins with `POST /v1/services/search` and
retrieves opaque continuation links with `GET`. Continuations and redirects must remain on the
selected canonical origin. `maxPages` defaults to 16, and callers can apply an independent
`maxItems` bound.

Short-lived clients resume a returned `next` reference with `continueSearchServices`. The client
validates the canonical origin and retrieves the continuation with GET without interpreting it.

Every result contains the Service origin, cached Service Document metadata, and `indexed_at`, which
records when that directory entry was refreshed. The agent should inspect the live Service before
navigating its Collections or Offerings.

Compatible results may advertise protocol names unknown to this package. The client filters those
descriptors and preserves recognized enrollment, payment, and trust descriptors, including TAP.

## Suggestions

`suggestServices` returns bounded lexical suggestions for a prefix. Natural-language interpretation
is not required by the directory contract.

```ts
const suggestions = await directory.suggestServices({ prefix: "gp", limit: 10 });
```

## Errors

Invalid local arguments throw `TypeError`. HTTP failures throw `DirectoryRequestError`, which
preserves the response status, headers, and bounded response message. The client rejects
cross-origin redirects and continuations before retrieving them.

## Related Documentation

- [Agent integration](../agent/README.md)
- [Core models and validation](../core/README.md)
- [Canonical directory](https://directory.inflowpay.ai/)
- [Normative specification and schemas](https://www.offeringprotocol.org/)
