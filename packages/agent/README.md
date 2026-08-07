# `@offering-protocol/agent`

Agent-oriented composition across directory discovery and per-Service catalog discovery.

## Install

```sh
npm install @offering-protocol/agent
```

## Discover Offerings Across Services

`createOdpAgent` searches the canonical directory and then searches each matching Service. Results
are emitted in directory order, while Service requests run with bounded concurrency. A failed
Service produces an `issue` event without discarding results from other Services.

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

The defaults search at most 10 Services, retain at most 10 terse Offerings per Service, and run four
Service searches concurrently. Callers can lower or raise those bounds within the documented
limits. The directory endpoint remains fixed by the selected production or sandbox environment.

Applications can supply `serviceClient` to configure authentication, payment-capable transport,
localization, persistent caching, or access-context cache partitions for each discovered Service.

## Inspect a Service

`inspectService` retrieves `/.well-known/odp`, validates the Service Document, and returns the
normalized capabilities an agent needs before navigating the catalog.

```ts
import { createInMemoryOdpCache, inspectService } from "@offering-protocol/agent";

const cache = createInMemoryOdpCache();
const service = await inspectService({
  serviceUrl: "https://compute.example",
  acceptLanguage: "en",
  cache
});

service.capabilities.operations;
service.capabilities.enrollment;
service.capabilities.payments;
```

The agent package owns HTTP freshness, validation, conditional revalidation, redirect safety, and
request coalescing. Responses without explicit freshness metadata receive a four-hour fallback.
Explicit `Cache-Control` and `Expires` metadata takes precedence.

Applications that need persistence can implement `OdpCache`. The interface stores opaque cache
records only; applications do not need to reproduce HTTP cache policy. Cache keys partition request
variants such as `Accept-Language`.

The built-in in-memory cache is optional. Without a supplied cache, each inspection fetches a fresh
Service Document.

## Navigate Collections

`createOdpServiceClient` refreshes Service inspection through its cache and exposes lazy item and
page iterables. It uses only operations advertised by the Service Document and creates an in-memory
cache when the application does not supply persistent storage.

Service Document, Collection, search, and search-definition fallback lifetimes are independently
configurable through `cacheFallbacks`; protocol defaults apply when they are omitted.

```ts
const odp = createOdpServiceClient({ serviceUrl: "https://compute.example", cache });
const results = odp.searchCollections({ parent_id: null });

for await (const collection of results.items) {
  useCollection(collection);
}
```

Applications can inject a fetch-compatible `transport` that handles live AEP, MPP, or x402
challenges. The client preserves response headers on `OdpRequestError` for that composition.
Catalog caching is disabled for a custom transport unless `cachePartition` identifies its stable
access context. Anonymous requests and each authenticated principal must use separate partition
values. Supporting schemas and OpenAPI documents remain in the anonymous partition.

Initial search responses are cached only when the Service supplies explicit freshness through
`Cache-Control` or `Expires`. The cache and request coalescer distinguish the complete search body,
representation, language, and access context. A search response without explicit freshness is not
stored; the configurable search fallback does not make it cacheable.

The `items` and `pages` iterables are independent. Iterating both starts two traversals, allowing
each consumer to stop without advancing or buffering the other.

Short-lived clients can resume a Service-provided `next` reference with `continueListCollections`,
`continueSearchCollections`, `continueListOfferings`, or `continueSearchOfferings`. Continuations
are retrieved with GET and remain subject to the same-origin, response, redirect, and traversal
limits as an uninterrupted sequence.

`getCollectionSearchCapabilities` returns validated Filter Definitions, Sort Definitions with their
filters resolved, and scoped `issues`. Callers do not need to retrieve linked definition pages,
merge Service and Collection scopes, or resolve sort references.

## Discover Offerings

The same client lists all accessible Offerings, lists direct members of one Collection, performs
structured Offering search, retrieves Offering details, and resolves the effective search
capabilities for either the Service or one Collection.

```ts
const results = odp.searchOfferings({
  collection_id: "compute",
  filters: [{ id: "region", operator: "eq", value: "us-west" }],
  refinements: ["region"]
});

for await (const offering of results.items) {
  useOffering(offering);
}
```

Offering retrieval uses a five-minute fallback freshness when the response does not supply HTTP
cache metadata. Search responses retain the explicit-freshness-only behavior described above.

Full Offering retrieval resolves and bundles the referenced JSON Schema, validates `attributes`,
and returns the self-contained schema as `attribute_schema`. Invalid or unavailable attributes are
omitted and described in the result's scoped `issues` array. Terse retrieval does not perform this
enrichment.

Action targets are normalized to absolute URLs during full Offering retrieval. Their supporting
documents remain lazy: `resolveAction(offeringId, actionId)` resolves a compact request schema or
validates an OpenAPI 3.1 document and selects its unique `operation_id`. It never invokes the
Action. An OpenAPI Action may omit its `url` when the Service Document declares
`http.openapi.url`; an Action URL overrides that Service-wide default.

```ts
const offering = await odp.getOffering("gpu-h100");

if (offering.actions?.some(({ id }) => id === "quote")) {
  const quote = await odp.resolveAction(offering.id, "quote");
  inspectAction(quote);
}
```

Attribute Schema and OpenAPI retrieval uses `supportingTransport`, which defaults to anonymous
`fetch` rather than the catalog `transport`. This keeps payment and enrollment credentials out of
supporting-document requests. Both transports may share the client's cache; supporting resources
use an anonymous cache partition.
