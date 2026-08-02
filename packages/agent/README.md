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
