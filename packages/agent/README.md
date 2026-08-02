# `@offering-protocol/agent`

Agent-oriented composition across directory discovery and per-Service catalog discovery.

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
service.capabilities.onboarding;
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
access context; separate principals must use separate partition values.

The `items` and `pages` iterables are independent. Iterating both starts two traversals, allowing
each consumer to stop without advancing or buffering the other.

`getCollectionSearchCapabilities` returns validated Filter Definitions, Sort Definitions with their
filters resolved, and scoped `issues`. Callers do not need to retrieve linked definition pages,
merge Service and Collection scopes, or resolve sort references.
