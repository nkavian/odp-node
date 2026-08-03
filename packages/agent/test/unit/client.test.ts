import { describe, expect, it, vi } from "vitest";

import {
  createInMemoryOdpCache,
  createOdpServiceClient,
  OdpRequestError
} from "../../src/index.js";

const service = {
  odp_version: "1.0",
  name: "Example",
  description: "Example catalog",
  language: "en",
  localizations: ["en"],
  operations: [
    { authentication: "not-required", name: "list-offerings" },
    { authentication: "not-required", name: "get-offering" },
    { authentication: "not-required", name: "list-collection-offerings" },
    { authentication: "not-required", name: "search-offerings" },
    { authentication: "not-required", name: "list-collections" },
    { authentication: "not-required", name: "search-collections" },
    { authentication: "not-required", name: "get-collection" }
  ],
  http: { endpoint_base: "/odp" }
};

function response(value: unknown, status = 200, type = "application/odp+json"): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": type } });
}

function transportFor(handler: (url: URL, init: RequestInit) => Response): typeof fetch {
  return vi.fn((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(
      handler(new URL(input instanceof Request ? input.url : String(input)), init ?? {})
    )
  );
}

describe("ODP Service Collection client", () => {
  it("lazily lists items and follows opaque continuation links", async () => {
    const transport = transportFor((url) => {
      if (url.pathname === "/.well-known/odp") return response(service);
      if (url.searchParams.has("cursor"))
        return response({ odp_version: "1.0", items: [{ id: "two", name: "Two" }] });
      return response({
        odp_version: "1.0",
        items: [{ id: "one", name: "One" }],
        next: "/odp/collections?cursor=opaque"
      });
    });
    const client = createOdpServiceClient({ serviceUrl: "https://example.com", transport });
    const result = client.listCollections({ maxItems: 2 });
    expect(transport).not.toHaveBeenCalled();
    const items = [];
    for await (const item of result.items) items.push(item["id"]);
    expect(items).toEqual(["one", "two"]);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("posts Collection search criteria and exposes pages", async () => {
    let request: RequestInit | undefined;
    const transport = transportFor((url, init) => {
      if (url.pathname === "/.well-known/odp") return response(service);
      request = init;
      return response({ odp_version: "1.0", items: [] });
    });
    const pages = client(transport).searchCollections({ parent_id: null, limit: 10 }).pages;
    for await (const page of pages) expect(page.items).toEqual([]);
    expect(request?.method).toBe("POST");
    expect(JSON.parse(typeof request?.body === "string" ? request.body : "null")).toEqual({
      odp_version: "1.0",
      parent_id: null,
      limit: 10
    });
  });

  it("resumes Collection search from a validated Service continuation", async () => {
    let method: string | undefined;
    const transport = transportFor((url, init) => {
      if (url.pathname === "/.well-known/odp") return response(service);
      method = init.method;
      return response({ odp_version: "1.0", items: [{ id: "next", name: "Next" }] });
    });
    const iterator = client(transport)
      .continueSearchCollections("/odp/collections/search?cursor=opaque")
      .pages[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { items: [{ id: "next" }] } });
    expect(method).toBe("GET");
  });

  it("caches explicitly fresh Collection searches and coalesces identical requests", async () => {
    let searches = 0;
    const transport = transportFor((url) => {
      if (url.pathname === "/.well-known/odp") return response(service);
      searches += 1;
      return new Response(JSON.stringify({ odp_version: "1.0", items: [] }), {
        headers: {
          "cache-control": "max-age=60",
          "content-type": "application/odp+json"
        }
      });
    });
    const odp = createOdpServiceClient({
      serviceUrl: "https://example.com",
      cachePartition: "agent",
      transport
    });
    const first = odp.searchCollections({ query: "compute" }).pages[Symbol.asyncIterator]();
    const second = odp.searchCollections({ query: "compute" }).pages[Symbol.asyncIterator]();
    await Promise.all([first.next(), second.next()]);
    await odp.searchCollections({ query: "compute" }).pages[Symbol.asyncIterator]().next();
    expect(searches).toBe(1);
  });

  it("does not cache Collection searches without explicit freshness", async () => {
    let searches = 0;
    const transport = transportFor((url) => {
      if (url.pathname === "/.well-known/odp") return response(service);
      searches += 1;
      return response({ odp_version: "1.0", items: [] });
    });
    const odp = createOdpServiceClient({
      serviceUrl: "https://example.com",
      cachePartition: "agent",
      transport
    });
    await odp.searchCollections({ query: "compute" }).pages[Symbol.asyncIterator]().next();
    await odp.searchCollections({ query: "compute" }).pages[Symbol.asyncIterator]().next();
    expect(searches).toBe(2);
  });

  it("isolates cached searches by body, representation, language, and access context", async () => {
    let searches = 0;
    const transport = transportFor((url) => {
      if (url.pathname === "/.well-known/odp") return response(service);
      searches += 1;
      return new Response(JSON.stringify({ odp_version: "1.0", items: [] }), {
        headers: {
          "cache-control": "max-age=60",
          "content-type": "application/odp+json"
        }
      });
    });
    const cache = createInMemoryOdpCache();
    const create = (cachePartition: string, acceptLanguage: string) =>
      createOdpServiceClient({
        serviceUrl: "https://example.com",
        acceptLanguage,
        cache,
        cachePartition,
        transport
      });
    const agent = create("agent-a", "en");
    await agent.searchCollections({ query: "compute" }).pages[Symbol.asyncIterator]().next();
    await agent.searchCollections({ query: "storage" }).pages[Symbol.asyncIterator]().next();
    await agent
      .searchCollections({ query: "compute", representation: "full" })
      .pages[Symbol.asyncIterator]()
      .next();
    await create("agent-a", "ja")
      .searchCollections({ query: "compute" })
      .pages[Symbol.asyncIterator]()
      .next();
    await create("agent-b", "en")
      .searchCollections({ query: "compute" })
      .pages[Symbol.asyncIterator]()
      .next();
    await agent.searchCollections({ query: "compute" }).pages[Symbol.asyncIterator]().next();
    expect(searches).toBe(5);
  });

  it("conditionally revalidates an explicitly stale Collection search", async () => {
    let searches = 0;
    let conditional: string | null = null;
    const transport = transportFor((url, init) => {
      if (url.pathname === "/.well-known/odp") return response(service);
      searches += 1;
      conditional = new Headers(init.headers).get("if-none-match");
      if (conditional !== null)
        return new Response(null, { status: 304, headers: { "cache-control": "max-age=60" } });
      return new Response(JSON.stringify({ odp_version: "1.0", items: [] }), {
        headers: {
          "cache-control": "max-age=0",
          "content-type": "application/odp+json",
          etag: '"search-1"'
        }
      });
    });
    const odp = createOdpServiceClient({
      serviceUrl: "https://example.com",
      cachePartition: "agent",
      transport
    });
    await odp.searchCollections({ query: "compute" }).pages[Symbol.asyncIterator]().next();
    await odp.searchCollections({ query: "compute" }).pages[Symbol.asyncIterator]().next();
    expect(searches).toBe(2);
    expect(conditional).toBe('"search-1"');
  });

  it("retrieves a Full Collection and requests localization", async () => {
    let headers: Headers | undefined;
    const transport = transportFor((url, init) => {
      if (url.pathname === "/.well-known/odp") return response(service);
      headers = new Headers(init.headers);
      return response({ odp_version: "1.0", id: "compute", name: "Compute" });
    });
    const collection = await createOdpServiceClient({
      serviceUrl: "https://example.com",
      acceptLanguage: "ja",
      transport
    }).getCollection("compute");
    expect(collection.id).toBe("compute");
    expect(headers?.get("accept-language")).toBe("ja");
  });

  it("propagates per-operation cancellation to Service inspection", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const transport = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      return Promise.reject(new Error("cancelled"));
    });
    await expect(
      createOdpServiceClient({ serviceUrl: "https://example.com", transport }).getCollection(
        "compute",
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({ code: "aborted" });
  });

  it("rejects detail representations whose identifiers do not match their paths", async () => {
    const transport = transportFor((url) =>
      url.pathname === "/.well-known/odp"
        ? response(service)
        : response({ odp_version: "1.0", id: "other", name: "Other" })
    );
    await expect(client(transport).getCollection("requested")).rejects.toThrow(
      "does not match its request path"
    );
  });

  it("does not call an unadvertised operation", async () => {
    const transport = transportFor(() =>
      response({
        ...service,
        operations: [
          { authentication: "not-required", name: "list-offerings" },
          { authentication: "not-required", name: "get-offering" }
        ]
      })
    );
    const iterator = createOdpServiceClient({ serviceUrl: "https://example.com", transport })
      .listCollections()
      .items[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow("does not advertise list-collections");
    expect(transport).toHaveBeenCalledOnce();
  });

  it("maps Problem Details while retaining challenge headers", async () => {
    const transport = transportFor((url) => {
      if (url.pathname === "/.well-known/odp") return response(service);
      return new Response(
        JSON.stringify({
          type: "https://offeringprotocol.org/problems/rate-limited",
          title: "Slow down",
          status: 429,
          code: "RATE_LIMITED"
        }),
        {
          status: 429,
          headers: {
            "content-type": "application/problem+json",
            "www-authenticate": "Payment challenge"
          }
        }
      );
    });
    const iterator = client(transport).listCollections().items[Symbol.asyncIterator]();
    try {
      await iterator.next();
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(OdpRequestError);
      expect(error).toMatchObject({ code: "RATE_LIMITED", retryable: true, status: 429 });
      if (error instanceof OdpRequestError)
        expect(error.headers.get("www-authenticate")).toBe("Payment challenge");
    }
  });

  it("resolves Service and Collection capability sources for the agent", async () => {
    const advertised = {
      ...service,
      search_capabilities: {
        filters: {
          inline: [
            {
              id: "region",
              title: "Region",
              description: "Deployment region",
              type: "string",
              operators: ["eq"]
            }
          ]
        }
      }
    };
    const transport = transportFor((url) => {
      if (url.pathname === "/.well-known/odp") return response(advertised);
      if (url.pathname === "/definitions/sorts")
        return response({
          odp_version: "1.0",
          items: [
            {
              id: "region-order",
              title: "Region order",
              description: "Orders by region",
              keys: [{ filter_id: "region", direction: "ascending", missing: "last" }]
            }
          ]
        });
      return response({
        odp_version: "1.0",
        id: "compute",
        name: "Compute",
        search_capabilities: { sorts: { linked: { href: "/definitions/sorts" } } }
      });
    });
    const catalog = await client(transport).getCollectionSearchCapabilities("compute");
    expect(catalog.filters.get("region")?.title).toBe("Region");
    expect(catalog.sorts.get("region-order")?.filters[0]?.id).toBe("region");
    expect(catalog.issues).toEqual([]);
  });

  it("applies the one-hour Collection fallback through the shared cache", async () => {
    const cache = createInMemoryOdpCache();
    const transport = transportFor((url) =>
      url.pathname === "/.well-known/odp"
        ? response(service)
        : response({ odp_version: "1.0", id: "compute", name: "Compute" })
    );
    const odp = createOdpServiceClient({
      serviceUrl: "https://example.com",
      cache,
      cachePartition: "public",
      transport
    });
    await odp.getCollection("compute");
    await odp.getCollection("compute");
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("partitions protected cache entries and disables them without a partition", async () => {
    const cache = createInMemoryOdpCache();
    const transport = transportFor((url) =>
      url.pathname === "/.well-known/odp"
        ? response(service)
        : response({ odp_version: "1.0", id: "compute", name: "Compute" })
    );
    const first = createOdpServiceClient({
      serviceUrl: "https://example.com",
      cache,
      cachePartition: "agent-a",
      transport
    });
    const second = createOdpServiceClient({
      serviceUrl: "https://example.com",
      cache,
      cachePartition: "agent-b",
      transport
    });
    await first.getCollection("compute");
    await second.getCollection("compute");
    await first.getCollection("compute");
    expect(transport).toHaveBeenCalledTimes(3);

    const unpartitioned = createOdpServiceClient({
      serviceUrl: "https://example.com",
      cache,
      transport
    });
    await unpartitioned.getCollection("compute");
    await unpartitioned.getCollection("compute");
    expect(transport).toHaveBeenCalledTimes(5);
  });

  it("coalesces identical Collection requests and repairs invalid cache records", async () => {
    const backing = createInMemoryOdpCache();
    const corruptingCache = {
      delete: (...args: Parameters<typeof backing.delete>) => backing.delete(...args),
      get: (...args: Parameters<typeof backing.get>) => backing.get(...args),
      set: (record: Parameters<typeof backing.set>[0]) =>
        backing.set(record.resourceClass === "collection" ? { ...record, value: {} } : record)
    };
    const transport = transportFor((url) =>
      url.pathname === "/.well-known/odp"
        ? response(service)
        : response({ odp_version: "1.0", id: "compute", name: "Compute" })
    );
    const odp = createOdpServiceClient({
      serviceUrl: "https://example.com",
      cache: corruptingCache,
      cachePartition: "agent",
      transport
    });
    await Promise.all([odp.getCollection("compute"), odp.getCollection("compute")]);
    expect(transport).toHaveBeenCalledTimes(2);
    await expect(odp.getCollection("compute")).resolves.toMatchObject({ id: "compute" });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("rejects cross-origin catalog redirects", async () => {
    const transport = transportFor((url) =>
      url.pathname === "/.well-known/odp"
        ? response(service)
        : new Response(null, { status: 302, headers: { location: "https://other.example/odp" } })
    );
    await expect(client(transport).getCollection("compute")).rejects.toThrow(
      "redirect changed origin"
    );
  });
});

describe("ODP Service Offering client", () => {
  it("lists Offerings and follows opaque continuation links", async () => {
    const transport = transportFor((url) => {
      if (url.pathname === "/.well-known/odp") return response(service);
      if (url.searchParams.has("cursor"))
        return response({ odp_version: "1.0", items: [{ id: "two", name: "Two" }] });
      return response({
        odp_version: "1.0",
        items: [{ id: "one", name: "One" }],
        next: "/odp/offerings?cursor=opaque"
      });
    });
    const ids = [];
    for await (const offering of client(transport).listOfferings().items) ids.push(offering.id);
    expect(ids).toEqual(["one", "two"]);
  });

  it("uses the fixed Collection membership path", async () => {
    let path = "";
    const transport = transportFor((url) => {
      if (url.pathname === "/.well-known/odp") return response(service);
      path = url.pathname;
      return response({ odp_version: "1.0", items: [] });
    });
    await client(transport).listCollectionOfferings("compute").pages[Symbol.asyncIterator]().next();
    expect(path).toBe("/odp/collections/compute/offerings");
  });

  it("posts structured Offering search criteria", async () => {
    let body: unknown;
    const transport = transportFor((url, init) => {
      if (url.pathname === "/.well-known/odp") return response(service);
      body = JSON.parse(typeof init.body === "string" ? init.body : "null");
      return response({ odp_version: "1.0", items: [] });
    });
    await client(transport)
      .searchOfferings({
        filters: [{ id: "region", operator: "eq", value: "us-west" }],
        collection_id: "compute",
        include_descendants: true,
        refinements: ["region"]
      })
      .pages[Symbol.asyncIterator]()
      .next();
    expect(body).toMatchObject({
      odp_version: "1.0",
      collection_id: "compute",
      include_descendants: true,
      refinements: ["region"]
    });
  });

  it("resumes Offering search and rejects cross-origin continuations", async () => {
    const transport = transportFor((url) =>
      url.pathname === "/.well-known/odp"
        ? response(service)
        : response({ odp_version: "1.0", items: [{ id: "next", name: "Next" }] })
    );
    const odp = client(transport);
    const pages = [];
    for await (const page of odp.continueSearchOfferings("/odp/offerings/search?cursor=opaque")
      .pages)
      pages.push(page);
    expect(pages[0]?.items).toEqual([{ id: "next", name: "Next" }]);
    await expect(
      odp
        .continueListOfferings("https://other.example/odp/offerings?cursor=opaque")
        .pages[Symbol.asyncIterator]()
        .next()
    ).rejects.toThrow("Service origin");
  });

  it("returns validated attributes with their bundled Attribute Schema", async () => {
    const transport = transportFor((url) =>
      url.pathname === "/.well-known/odp"
        ? response(service)
        : response({
            odp_version: "1.0",
            id: "gpu",
            name: "GPU",
            schema: { url: "/schemas/gpu" },
            attributes: { memory: 80 }
          })
    );
    const supportingTransport = transportFor((url) =>
      response(
        url.pathname.endsWith("memory.json")
          ? {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              type: "number"
            }
          : {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              type: "object",
              required: ["memory"],
              properties: { memory: { $ref: "memory.json" } }
            },
        200,
        "application/schema+json"
      )
    );
    const offering = await createOdpServiceClient({
      serviceUrl: "https://example.com",
      transport,
      supportingTransport
    }).getOffering("gpu");
    expect(offering).toMatchObject({
      id: "gpu",
      attributes: { memory: 80 },
      attribute_schema: { type: "object" }
    });
    expect(offering).not.toHaveProperty("issues");
    expect(supportingTransport).toHaveBeenCalledTimes(2);
  });

  it("quarantines attributes that fail their Attribute Schema", async () => {
    const transport = transportFor((url) =>
      url.pathname === "/.well-known/odp"
        ? response(service)
        : response({
            odp_version: "1.0",
            id: "gpu",
            name: "GPU",
            schema: { url: "/schemas/gpu" },
            attributes: { memory: "eighty" }
          })
    );
    const supportingTransport = transportFor(() =>
      response(
        {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { memory: { type: "number" } }
        },
        200,
        "application/schema+json"
      )
    );
    const offering = await createOdpServiceClient({
      serviceUrl: "https://example.com",
      transport,
      supportingTransport
    }).getOffering("gpu");
    expect(offering).not.toHaveProperty("attributes");
    expect(offering.issues).toEqual([
      {
        scope: "attributes",
        message: "Offering attributes do not match their Attribute Schema"
      }
    ]);
  });

  it("normalizes Actions without eagerly retrieving their supporting documents", async () => {
    const transport = transportFor((url) =>
      url.pathname === "/.well-known/odp"
        ? response(service)
        : response({
            auth_expands: true,
            odp_version: "1.0",
            id: "gpu",
            name: "GPU",
            actions: [
              {
                authentication: "required",
                id: "rent",
                rel: "purchase",
                http: { href: "/rentals", method: "POST" }
              },
              {
                authentication: "optional",
                id: "quote",
                rel: "quote",
                openapi: { url: "/openapi.json", operation_id: "createQuote" }
              }
            ]
          })
    );
    const supportingTransport = transportFor(() => {
      throw new Error("supporting document retrieval must remain lazy");
    });
    const offering = await createOdpServiceClient({
      serviceUrl: "https://example.com",
      transport,
      supportingTransport
    }).getOffering("gpu");
    expect(offering.auth_expands).toBe(true);
    expect(offering.actions).toEqual([
      {
        authentication: "required",
        id: "rent",
        rel: "purchase",
        target: { kind: "http", url: "https://example.com/rentals", method: "POST" }
      },
      {
        authentication: "optional",
        id: "quote",
        rel: "quote",
        target: {
          kind: "openapi",
          url: "https://example.com/openapi.json",
          operation_id: "createQuote"
        }
      }
    ]);
    expect(supportingTransport).not.toHaveBeenCalled();
  });

  it("lazily resolves an OpenAPI Action to exactly one operation", async () => {
    const transport = transportFor((url) =>
      url.pathname === "/.well-known/odp"
        ? response(service)
        : response({
            odp_version: "1.0",
            id: "gpu",
            name: "GPU",
            actions: [
              {
                authentication: "required",
                id: "quote",
                rel: "quote",
                openapi: { url: "/openapi.json", operation_id: "createQuote" }
              }
            ]
          })
    );
    const supportingTransport = transportFor(() =>
      response(
        {
          openapi: "3.1.1",
          info: { title: "Quote API", version: "1.0.0" },
          paths: {
            "/quotes": {
              post: { operationId: "createQuote", responses: { "200": { description: "OK" } } }
            }
          }
        },
        200,
        "application/vnd.oai.openapi+json;version=3.1"
      )
    );
    const resolved = await createOdpServiceClient({
      serviceUrl: "https://example.com",
      transport,
      supportingTransport
    }).resolveAction("gpu", "quote");
    expect(resolved.action.target.kind).toBe("openapi");
    expect("operation" in resolved && resolved.operation["operationId"]).toBe("createQuote");
  });
});

function client(transport: typeof fetch) {
  return createOdpServiceClient({ serviceUrl: "https://example.com", transport });
}
