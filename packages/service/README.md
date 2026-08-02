# `@offering-protocol/service`

Framework-neutral Service integration for the Offering Discovery Protocol.

`createOdpService` owns the well-known document, fixed ODP routes, representation defaults, request
validation, bounded JSON parsing, media-type negotiation, localization headers, response validation,
and Problem Details. Its `fetch(Request)` interface works with Node.js and frameworks that accept
Web-standard request handlers.

## Small catalogs

`createStaticCatalog` provides the required `list-offerings` and `get-offering` operations from a
small in-memory catalog. Configuring Collections also enables Collection listing, retrieval, and
direct Offering membership automatically.

```ts
import { createOdpService, createStaticCatalog } from "@offering-protocol/service";

const odp = createOdpService({
  document: {
    name: "Example Compute",
    description: "On-demand compute resources",
    language: "en",
    localizations: ["en"],
    http: { endpoint_base: "/odp" }
  },
  catalog: createStaticCatalog({
    offerings: [
      {
        odp_version: "1.0",
        id: "gpu-h100",
        name: "H100 GPU",
        price: { type: "starting_at", amount: "2.50", currency: "USD" }
      }
    ]
  })
});

const response = await odp.fetch(request);
```

The static catalog validates its configuration immediately and uses opaque, server-managed
continuation cursors. It is intended for small catalogs, examples, and tests.

## Storage-backed catalogs

Large Services implement `OdpCatalog` directly. Each handler receives the original `Request` plus
the normalized representation, language, limit, and opaque cursor. The Service runtime does not
load, copy, sort, or index the complete catalog.

```ts
const odp = createOdpService({
  document: marketplaceDocument,
  catalog: {
    listOfferings: ({ cursor, limit, representation }) =>
      database.listOfferings({ cursor, limit, representation }),
    getOffering: (id, { representation }) => database.getOffering(id, representation),
    searchOfferings: (query, request) =>
      query === undefined
        ? database.continueOfferingSearch(request.cursor)
        : database.searchOfferings(query, request.representation)
  }
});
```

`searchOfferings` and `searchCollections` receive the validated search body for the initial `POST`.
A continuation `GET` supplies `undefined` as the query and the opaque cursor in the request context,
so the application can recover server-managed or integrity-protected stateless search state.

The Service Document always advertises the required `list-offerings` and `get-offering` operations.
Optional operations are advertised only when their corresponding handlers are configured. There is
no second capability manifest to keep synchronized.

Catalog handlers may throw `OdpServiceError` to return an intentional ODP Problem Details response.
Unexpected handler failures produce a generic `500` response without exposing implementation data.
AEP, MPP, x402, and application authorization wrap `service.fetch`; the package does not infer an
access mode or invoke payment and onboarding protocols.
