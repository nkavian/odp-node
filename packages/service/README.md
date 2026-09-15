# `@offering-protocol/service`

Framework-neutral Service integration for the Offering Discovery Protocol.

Service Documents are validated against the declared ODP version. Protocol advertisements accept
only the enrollment, payment, and trust protocol names defined by that version.

## Install

```sh
npm install @offering-protocol/service
```

`createOdpService` owns the well-known document, fixed ODP routes, representation defaults, request
validation, bounded JSON parsing, media-type negotiation, localization headers, response validation,
and Problem Details. Its `fetch(Request)` interface works with Node.js and frameworks that accept
Web-standard request handlers.

Every successful ODP document response carries a strong `ETag` over the exact bytes served and
`Vary: Accept, Accept-Language`, so a conditional `GET` carrying `If-None-Match` is answered `304`
without a second transfer. `HEAD` is answered with the `GET` status and headers and no body.
Responses are validated against the protocol's byte and nesting-depth limits before they leave the
Service: a catalog that produces an over-limit document gets a `500` here rather than a truncated
read at the Agent.

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
stateless continuation cursors bound to the operation, page size, and representation that produced
them. Pages default to 50 items, accept limits through 100, and issue continuations that expire
after one hour. Supply `continuationKey` — a stable secret of at least 32 bytes — to keep
continuations usable across a restart and across the processes behind one origin; without it a
random key is generated and every cursor is confined to that one catalog instance. It is intended
for small catalogs, examples, and tests.

## Storage-backed catalogs

Large Services implement `OdpCatalog` directly. Each handler receives the original `Request` plus
the normalized representation, language, limit, and opaque cursor. The Service runtime does not
load, copy, sort, or index the complete catalog.

`language` is the tag chosen by RFC 4647 Lookup over the Service Document's `localizations`, not the
raw `Accept-Language` header; it is `undefined` when the request expressed no preference this
Service can serve, and the default language applies. A handler that returns a resource declaring its
own `language` overrides that choice in `Content-Language`. `localizations` describes the Service
Document itself, so a catalog whose Collections and Offerings are localized separately reads
`Accept-Language` from `request` and runs its own Lookup; `selectLanguage` is exported for that.

The runtime validates the whole page envelope a handler returns, not only its items. A page is
refused with a `500` when it holds more than 100 items, when `next` is not an ASCII reference of at
most 2048 characters that resolves to the Service origin and advances past the current request, when
`refinements` appear outside the initial response of a search that asked for them or repeat a
`filter_id`, when a Terse Offering carries Actions or a Full Representation carries `detail_fields`,
or when a retrieved resource's `id` does not match the path it was requested at. The `odp_version` an
item inherits from its page is removed rather than refused, so a handler that restates it still
returns `200`.

Requests are answered from a single Service Document, so list only the tags that document is
actually served in under `localizations`.

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
Unexpected handler failures produce a generic `500` response without exposing implementation data;
pass `onError` to observe them, since a generic `500` is otherwise indistinguishable from a healthy
Service.

`operationAuthentication` advertises an access policy; it does not enforce one. AEP, MPP, x402, and
application authorization wrap `service.fetch`; the package does not infer an access mode or invoke
payment and enrollment protocols. A response for an operation advertised as `optional` or `required`
carries `Cache-Control: private` and adds `Authorization` to `Vary`, so a shared cache cannot reuse
it across authentication contexts.

## Errors

Throw `OdpServiceError` from a catalog handler when the caller should receive a specific HTTP
status, ODP error code, and safe message. Request parsing, media negotiation, operation routing, and
response validation failures are converted into ODP Problem Details by the runtime. Unexpected
exceptions are not exposed to the caller.

The runtime normalizes what it is given: a status outside 400-599 or a code outside the ODP problem
code grammar becomes a generic `500`, a title longer than 128 code points is truncated, and `429`
and `503` responses carry `Retry-After` when the handler did not supply one.

## Related Documentation

- [Core models and validation](../core/README.md)
- [Agent integration](../agent/README.md)
- [Small Service example](../../examples/odp-service-small/README.md)
- [Marketplace Service example](../../examples/odp-service-marketplace/README.md)
- [Normative specification and schemas](https://www.offeringprotocol.org/)
