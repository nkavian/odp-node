# `@offering-protocol/core`

Transport-independent protocol models, validation, resource identity, references, operation URLs,
Problem Details, and pagination for the Offering Discovery Protocol.

## Install

```sh
npm install @offering-protocol/core
```

## Validate and Decode Documents

```ts
import {
  OdpValidationError,
  createResourceIdentity,
  parseAgentServiceDocument,
  parseOffering,
  safeParseServiceDocument
} from "@offering-protocol/core";

const service = safeParseServiceDocument(unknownDocument);
if (!service.success) {
  service.issues.forEach(({ path, message }) => report(`${path}: ${message}`));
}

try {
  const offering = parseOffering(unknownOffering);
  const identity = createResourceIdentity(serviceDocumentUrl, "offering", offering.id);
} catch (error) {
  if (error instanceof OdpValidationError) report(error.issues);
}

const compatibleService = parseAgentServiceDocument(unknownServiceDocument);
```

Each supported document has a throwing `parse*` function and a non-throwing `safeParse*` function.
Validation uses the JSON Schemas published by
[`odp-specs`](https://github.com/offering-protocol/odp-specs) and preserves unknown additive members
allowed by the protocol.

Invalid documents throw `OdpValidationError`. Its `issues` member identifies each invalid path and
the corresponding validation message. Use the non-throwing functions when invalid peer input is an
expected application outcome.

Service authoring uses `parseServiceDocument` or `safeParseServiceDocument` and rejects protocol
names outside the declared ODP version. Agent readers use `parseAgentServiceDocument` or
`safeParseAgentServiceDocument`; these filter unrecognized enrollment, payment, and trust
descriptors before validating every recognized descriptor.

## Resource Identity and References

`createResourceIdentity` composes the Service origin, resource type, and Service-assigned local
identifier into the stable identity an Agent uses across responses. Operation URL helpers resolve
the fixed ODP paths from the Service Document's `http.endpoint_base`.

Relative resource, supporting-document, and Action references resolve against the Service origin.
Continuation references must remain on that origin and are rejected when they cross an origin
boundary.

## Pagination

Pagination exposes both page and item asynchronous iterables. Continuation values remain opaque and
are passed unchanged to the caller-supplied page loader.

Traversal rejects continuation loops and is bounded to 16 pages. Applications should also set an
item ceiling appropriate for their workload rather than assuming a Service catalog is small.

## Payment Option Vocabulary

Service payment descriptors may advertise a bounded `options` list such as `inflow`, `solana`, or
`base`. `PAYMENT_OPTIONS` supplies the closed runtime vocabulary and `PaymentOption` supplies its
TypeScript type. These labels summarize compatibility; live MPP and x402 responses provide the
authoritative payment terms.

Service trust descriptors advertise supported trust protocols. A Service that accepts Visa Trusted
Agent Protocol requests declares `protocols.trust: [{ name: "tap" }]`.

## Related Documentation

- [Agent integration](../agent/README.md)
- [Directory integration](../directory/README.md)
- [Service integration](../service/README.md)
- [Normative specification and schemas](https://www.offeringprotocol.org/)
