# `@offering-protocol/core`

Transport-independent protocol models, validation, resource identity, references, operation URLs,
Problem Details, and pagination for the Offering Discovery Protocol.

## Install

```sh
npm install @offering-protocol/core
```

```ts
import {
  OdpValidationError,
  createResourceIdentity,
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
```

Each supported document has a throwing `parse*` function and a non-throwing `safeParse*` function.
Validation uses the JSON Schemas published by
[`odp-specs`](https://github.com/offering-protocol/odp-specs) and preserves unknown additive members
allowed by the protocol.

Pagination exposes both page and item asynchronous iterables. Continuation values remain opaque and
are passed unchanged to the caller-supplied page loader.
