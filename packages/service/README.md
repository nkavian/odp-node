# `@offering-protocol/service`

Framework-neutral Service integration for the Offering Discovery Protocol.

## Install

```sh
npm install @offering-protocol/service
```

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
    branding: {
      icon: { src: "/branding/icon.svg", type: "image/svg+xml" },
      logo: { src: "/branding/logo.svg", type: "image/svg+xml" }
    },
    description: "On-demand compute resources",
    http: {
      endpoint_base: "/odp",
      openapi: { url: "/openapi.json" }
    },
    language: "en",
    localizations: ["en"],
    name: "Example Compute"
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

The static catalog validates its configuration immediately and uses opaque, integrity-protected
stateless continuation cursors. It is intended for small catalogs, examples, and tests.

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

`branding` is optional. When present, it contains both a square `icon` and a wide `logo` as SVG,
PNG, or WebP resources. Raster icons are square and at least 200 by 200 pixels; raster logos use a
4:1 aspect ratio and are at least 400 by 100 pixels. SVG resources use the corresponding aspect
ratio. Each image's optional `type` provides a pre-retrieval format hint; provide it when the
resource URL does not have a recognizable filename extension. `http.openapi` is also optional and
supplies the default OpenAPI document for Offering Actions that identify only an `operation_id`.

`searchOfferings` and `searchCollections` receive the validated search body for the initial `POST`.
A continuation `GET` supplies `undefined` as the query and the opaque cursor in the request context,
so the application can recover server-managed or integrity-protected stateless search state.

The Service Document always advertises the required `list-offerings` and `get-offering` operations.
Optional operations are advertised only when their corresponding handlers are configured. There is
no second capability manifest to keep synchronized.

Every advertised operation defaults to `authentication: "not-required"`. Set
`operationAuthentication` only for operations that support or require the Service's advertised
enrollment protocol.

```ts
const odp = createOdpService({
  document: {
    ...serviceDocument,
    protocols: { enrollment: [{ name: "aep" }] }
  },
  catalog,
  operationAuthentication: {
    "get-offering": "optional",
    "search-offerings": "required"
  }
});
```

Catalog handlers may throw `OdpServiceError` to return an intentional ODP Problem Details response.
Unexpected handler failures produce a generic `500` response without exposing implementation data.
AEP, MPP, x402, and application authorization wrap `service.fetch`; the package does not infer an
access mode or invoke payment and enrollment protocols.
