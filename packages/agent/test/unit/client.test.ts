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
  operations: {
    supported: [
      "list-offerings",
      "get-offering",
      "list-collections",
      "search-collections",
      "get-collection"
    ]
  },
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

  it("does not call an unadvertised operation", async () => {
    const transport = transportFor(() =>
      response({ ...service, operations: { supported: ["list-offerings", "get-offering"] } })
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
      operations: { supported: [...service.operations.supported, "search-offerings"] },
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

function client(transport: typeof fetch) {
  return createOdpServiceClient({ serviceUrl: "https://example.com", transport });
}
