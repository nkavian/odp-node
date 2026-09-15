import { describe, expect, it, vi } from "vitest";

import { createInMemoryOdpCache, createOdpServiceClient } from "../../src/index.js";
import type { OdpTransport } from "../../src/transport.js";

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

function transportFor(handler: (url: URL, init: RequestInit) => Response): OdpTransport {
  return vi.fn((url: URL, init?: RequestInit) => Promise.resolve(handler(url, init ?? {})));
}

/** A catalog of `total` Offerings served `perPage` at a time through opaque continuation links. */
function pagedOfferings(total: number, perPage: number) {
  let pages = 0;
  const transport = transportFor((url) => {
    if (url.pathname === "/.well-known/odp") return response(service);
    pages += 1;
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const items = Array.from({ length: Math.min(perPage, total - offset) }, (_value, index) => ({
      id: `o${String(offset + index)}`,
      name: `Offering ${String(offset + index)}`
    }));
    const next = offset + items.length;
    return response({
      odp_version: "1.0",
      items,
      ...(next >= total ? {} : { next: `/odp/offerings?offset=${String(next)}` })
    });
  });
  return { transport, pages: () => pages };
}

function client(transport: OdpTransport) {
  return createOdpServiceClient({ serviceUrl: "https://example.com", transport });
}

describe("caller-bounded traversal", () => {
  it("does not request another page once maxItems is reached on a page boundary", async () => {
    const catalog = pagedOfferings(100, 10);
    const items: string[] = [];
    for await (const item of client(catalog.transport).listOfferings({ maxItems: 10 }).items)
      items.push(item.id);
    expect(items).toHaveLength(10);
    // Checking the limit before yielding meant the enclosing loop pulled page two first.
    expect(catalog.pages()).toBe(1);
  });

  it("still stops mid-page when maxItems falls inside one", async () => {
    const catalog = pagedOfferings(100, 10);
    const items: string[] = [];
    for await (const item of client(catalog.transport).listOfferings({ maxItems: 4 }).items)
      items.push(item.id);
    expect(items).toHaveLength(4);
    expect(catalog.pages()).toBe(1);
  });

  it("follows a continuation sequence past sixteen pages", async () => {
    const catalog = pagedOfferings(400, 10);
    const items: string[] = [];
    for await (const item of client(catalog.transport).listOfferings().items) items.push(item.id);
    // The 16-page ceiling belongs to a linked capability source, not to catalog traversal, and an
    // Agent baseline has to be able to reach the end of the sequence.
    expect(items).toHaveLength(400);
    expect(catalog.pages()).toBe(40);
  });

  it("ends the sequence cleanly when the caller's own maxPages is reached", async () => {
    const catalog = pagedOfferings(400, 10);
    const items: string[] = [];
    for await (const item of client(catalog.transport).listOfferings({ maxPages: 3 }).items)
      items.push(item.id);
    expect(items).toHaveLength(30);
    expect(catalog.pages()).toBe(3);
  });

  it("exposes the unfinished sequence through the last page's continuation link", async () => {
    const catalog = pagedOfferings(400, 10);
    const pages = [];
    for await (const page of client(catalog.transport).listOfferings({ maxPages: 2 }).pages)
      pages.push(page);
    expect(pages).toHaveLength(2);
    expect(pages[1]?.next).toBeDefined();
  });

  it("rejects a maxPages or maxItems that is not a positive integer", async () => {
    const catalog = pagedOfferings(10, 10);
    const odp = client(catalog.transport);
    expect(() => odp.listOfferings({ maxItems: 0 })).toThrow("maxItems");
    const sequence = odp.listOfferings({ maxPages: 0 });
    await expect(sequence.pages[Symbol.asyncIterator]().next()).rejects.toThrow("maxPages");
  });

  it("detects a continuation link that resolves back to a page already visited", async () => {
    const transport = transportFor((url) => {
      if (url.pathname === "/.well-known/odp") return response(service);
      return response({
        odp_version: "1.0",
        items: [{ id: "one", name: "One" }],
        // Absolute spelling of a URL already fetched: comparing raw strings would miss it.
        next: "https://example.com/odp/offerings?limit=50"
      });
    });
    const items: string[] = [];
    await expect(
      (async () => {
        for await (const item of client(transport).listOfferings().items) items.push(item.id);
      })()
    ).rejects.toThrow("pagination loop");
  });
});

describe("representation on continuations", () => {
  it("accepts a Full item on a continuation the caller did not label", async () => {
    const transport = transportFor((url) => {
      if (url.pathname === "/.well-known/odp") return response(service);
      return response({
        odp_version: "1.0",
        items: [
          {
            id: "one",
            name: "One",
            actions: [
              {
                authentication: "not-required",
                id: "buy",
                rel: "purchase",
                http: { href: "/buy", method: "POST" }
              }
            ]
          }
        ]
      });
    });
    // The representation was fixed by the request that produced the link, which this call cannot
    // see, so it must not be asserted against the terse default.
    const items = [];
    for await (const item of client(transport).continueListOfferings("/odp/offerings?cursor=x")
      .items)
      items.push(item);
    expect(items).toHaveLength(1);
  });

  it("still enforces a representation the caller states explicitly", async () => {
    const transport = transportFor((url) => {
      if (url.pathname === "/.well-known/odp") return response(service);
      return response({
        odp_version: "1.0",
        items: [{ id: "one", name: "One", detail_fields: ["/price"] }]
      });
    });
    await expect(
      (async () => {
        await drain(
          client(transport).continueListOfferings("/odp/offerings?c=1", {
            representation: "full"
          }).items
        );
      })()
    ).rejects.toThrow("detail_fields");
  });

  it("rejects a terse item that restates the protocol version", async () => {
    const transport = transportFor((url) => {
      if (url.pathname === "/.well-known/odp") return response(service);
      return response({
        odp_version: "1.0",
        items: [{ odp_version: "1.0", id: "one", name: "One" }]
      });
    });
    await expect(
      (async () => {
        await drain(client(transport).listOfferings().items);
      })()
    ).rejects.toThrow("repeat odp_version");
  });
});

describe("Offering search refinements", () => {
  const group = { filter_id: "region", values: [{ value: "eu", count: 3 }] };

  function searchTransport(body: unknown): OdpTransport {
    return transportFor((url) => {
      if (url.pathname === "/.well-known/odp") return response(service);
      return response(body);
    });
  }

  it("returns refinement groups the request asked for", async () => {
    const transport = searchTransport({ odp_version: "1.0", items: [], refinements: [group] });
    const pages = client(transport).searchOfferings({
      query: "gpu",
      refinements: ["region"]
    }).pages;
    for await (const page of pages) expect(page["refinements"]).toEqual([group]);
  });

  it("refuses refinements the request never asked for", async () => {
    const transport = searchTransport({ odp_version: "1.0", items: [], refinements: [group] });
    await expect(
      (async () => {
        await drain(client(transport).searchOfferings({ query: "gpu" }).pages);
      })()
    ).rejects.toThrow("not requested");
  });

  it("refuses a group for a filter that was not requested", async () => {
    const transport = searchTransport({
      odp_version: "1.0",
      items: [],
      refinements: [{ filter_id: "zone", values: [{ value: "a", count: 1 }] }]
    });
    await expect(
      (async () => {
        await drain(
          client(transport).searchOfferings({ query: "gpu", refinements: ["region"] }).pages
        );
      })()
    ).rejects.toThrow("zone");
  });

  it("refuses a repeated refinement group", async () => {
    const transport = searchTransport({
      odp_version: "1.0",
      items: [],
      refinements: [group, group]
    });
    await expect(
      (async () => {
        await drain(
          client(transport).searchOfferings({ query: "gpu", refinements: ["region"] }).pages
        );
      })()
    ).rejects.toThrow("repeated refinement group");
  });

  it("refuses refinements on a continuation page", async () => {
    let call = 0;
    const transport = transportFor((url) => {
      if (url.pathname === "/.well-known/odp") return response(service);
      call += 1;
      if (call === 1)
        return response({
          odp_version: "1.0",
          items: [],
          refinements: [group],
          next: "/odp/offerings/search?cursor=x"
        });
      return response({ odp_version: "1.0", items: [], refinements: [group] });
    });
    await expect(
      (async () => {
        await drain(
          client(transport).searchOfferings({ query: "gpu", refinements: ["region"] }).pages
        );
      })()
    ).rejects.toThrow("continuation cannot contain refinements");
  });
});

describe("client surface", () => {
  const transport = (): OdpTransport =>
    transportFor((url) => {
      if (url.pathname === "/.well-known/odp") return response(service);
      if (url.pathname.startsWith("/odp/collections/"))
        return response({ odp_version: "1.0", id: "compute", name: "Compute" });
      return response({ odp_version: "1.0", items: [] });
    });

  it("works when its methods are detached from the client object", async () => {
    // These two used to reach for `this`, so a destructured reference threw.
    // Detaching the methods is the point of this test.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const { getCollectionSearchCapabilities, getOfferingSearchCapabilities } = client(transport());
    await expect(getOfferingSearchCapabilities()).resolves.toBeDefined();
    await expect(getCollectionSearchCapabilities("compute")).resolves.toBeDefined();
  });

  it("aborts catalog requests through the client-wide signal", async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | null | undefined)[] = [];
    const odp = createOdpServiceClient({
      serviceUrl: "https://example.com",
      signal: controller.signal,
      transport: transportFor((url, init) => {
        seen.push(init.signal);
        if (url.pathname === "/.well-known/odp") return response(service);
        return response({ odp_version: "1.0", id: "compute", name: "Compute" });
      })
    });
    await odp.getCollection("compute");
    // The client-wide signal used to reach inspection only, silently ignoring it everywhere else.
    const catalogSignal = seen.at(-1);
    expect(catalogSignal).toBeDefined();
    expect(catalogSignal?.aborted).toBe(false);
    controller.abort();
    expect(catalogSignal?.aborted).toBe(true);
  });

  it("combines a client-wide signal with a per-operation one", async () => {
    const client_ = new AbortController();
    const operation = new AbortController();
    let seen: AbortSignal | null | undefined;
    const odp = createOdpServiceClient({
      serviceUrl: "https://example.com",
      signal: client_.signal,
      transport: transportFor((url, init) => {
        if (url.pathname === "/.well-known/odp") return response(service);
        seen = init.signal;
        return response({ odp_version: "1.0", id: "compute", name: "Compute" });
      })
    });
    await odp.getCollection("compute", { signal: operation.signal });
    operation.abort();
    expect(seen?.aborted).toBe(true);
  });

  it("refuses an empty cache partition", () => {
    expect(() =>
      createOdpServiceClient({
        serviceUrl: "https://example.com",
        cachePartition: "",
        transport: transport()
      })
    ).toThrow("cachePartition");
  });

  it("refuses a negative cache fallback and an out-of-range initial page size", () => {
    expect(() =>
      createOdpServiceClient({
        serviceUrl: "https://example.com",
        cacheFallbacks: { offeringMs: -1 },
        transport: transport()
      })
    ).toThrow("non-negative");
    expect(() =>
      createOdpServiceClient({
        serviceUrl: "https://example.com",
        initialPageSize: 101,
        transport: transport()
      })
    ).toThrow("initialPageSize");
  });

  it("reuses one Service Document across the operations of a single client", async () => {
    const impl = transport();
    const odp = createOdpServiceClient({
      serviceUrl: "https://example.com",
      cache: createInMemoryOdpCache(),
      cachePartition: "public",
      transport: impl
    });
    await Promise.all([odp.getCollection("compute"), odp.getCollection("compute")]);
    const wellKnown = (impl as unknown as { mock: { calls: [URL][] } }).mock.calls.filter(
      ([url]) => url.pathname === "/.well-known/odp"
    );
    expect(wellKnown).toHaveLength(1);
  });
});
describe("Action and capability resolution", () => {
  const withSchema = {
    odp_version: "1.0",
    id: "gpu",
    name: "GPU",
    actions: [
      {
        authentication: "not-required",
        id: "buy",
        rel: "purchase",
        http: {
          href: "/buy",
          method: "POST",
          request: { schema: { url: "https://schemas.example/buy.json" } }
        }
      }
    ]
  };

  it("resolves the request schema of a compact HTTP Action", async () => {
    const supporting: OdpTransport = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: { quantity: { type: "integer" } }
          }),
          { headers: { "content-type": "application/schema+json" } }
        )
      )
    );
    const odp = createOdpServiceClient({
      serviceUrl: "https://example.com",
      supportingTransport: supporting,
      transport: transportFor((url) =>
        url.pathname === "/.well-known/odp" ? response(service) : response(withSchema)
      )
    });
    const resolved = await odp.resolveAction("gpu", "buy");
    expect(resolved.action.target.kind).toBe("http");
    expect("request_schema" in resolved && resolved.request_schema).toMatchObject({
      type: "object"
    });
    expect(supporting).toHaveBeenCalledTimes(1);
  });

  it("returns a compact Action that declares no request schema unchanged", async () => {
    const odp = client(
      transportFor((url) =>
        url.pathname === "/.well-known/odp"
          ? response(service)
          : response({
              ...withSchema,
              actions: [
                {
                  authentication: "not-required",
                  id: "buy",
                  rel: "purchase",
                  http: { href: "/buy", method: "POST" }
                }
              ]
            })
      )
    );
    const resolved = await odp.resolveAction("gpu", "buy");
    expect("request_schema" in resolved).toBe(false);
  });

  it("refuses to resolve an Action the Offering does not usably expose", async () => {
    const odp = client(
      transportFor((url) =>
        url.pathname === "/.well-known/odp" ? response(service) : response(withSchema)
      )
    );
    await expect(odp.resolveAction("gpu", "missing")).rejects.toThrow("does not expose usable");
  });

  it("loads linked filter and sort definitions for a Collection scope", async () => {
    const filter = {
      id: "region",
      title: "Region",
      description: "Deployment region",
      type: "string",
      operators: ["eq"]
    };
    const sort = {
      id: "region-order",
      title: "Region order",
      description: "By region",
      keys: [{ filter_id: "region", direction: "ascending", missing: "last" }]
    };
    const odp = client(
      transportFor((url) => {
        if (url.pathname === "/.well-known/odp")
          return response({
            ...service,
            search_capabilities: { filters: { linked: { href: "/odp/filters" } } }
          });
        if (url.pathname === "/odp/filters")
          return response({ odp_version: "1.0", items: [filter] });
        if (url.pathname === "/odp/sorts") return response({ odp_version: "1.0", items: [sort] });
        return response({
          odp_version: "1.0",
          id: "compute",
          name: "Compute",
          search_capabilities: { sorts: { linked: { href: "/odp/sorts" } } }
        });
      })
    );
    const catalog = await odp.getOfferingSearchCapabilities("compute");
    expect(catalog.filters.get("region")?.title).toBe("Region");
    expect(catalog.sorts.get("region-order")?.filters[0]?.id).toBe("region");
    expect(catalog.issues).toEqual([]);
  });

  it("returns an empty catalog for a Service that advertises no capabilities", async () => {
    const catalog = await client(
      transportFor((url) =>
        url.pathname === "/.well-known/odp" ? response(service) : response({})
      )
    ).getOfferingSearchCapabilities();
    expect(catalog.filters.size).toBe(0);
    expect(catalog.sorts.size).toBe(0);
  });
});

describe("typed sequence entry points", () => {
  const full = {
    odp_version: "1.0",
    items: [{ id: "one", name: "One", description: "Full item" }]
  };
  const transport = (): OdpTransport =>
    transportFor((url) =>
      url.pathname === "/.well-known/odp" ? response(service) : response(full)
    );

  it("requests Full Offerings from a search and from its continuation", async () => {
    const odp = client(transport());
    for await (const item of odp.searchOfferings({ query: "gpu", representation: "full" }).items)
      expect(item.description).toBe("Full item");
    for await (const item of odp.continueSearchOfferings("/odp/offerings/search?c=1", {
      representation: "full"
    }).items)
      expect(item.description).toBe("Full item");
  });

  it("requests Full Collections from a list, a search and their continuations", async () => {
    const odp = client(transport());
    const sequences = [
      odp.listCollections({ representation: "full" }),
      odp.searchCollections({ query: "compute", representation: "full" }),
      odp.continueListCollections("/odp/collections?c=1", { representation: "full" }),
      odp.continueSearchCollections("/odp/collections/search?c=1", { representation: "full" })
    ];
    for (const sequence of sequences)
      for await (const item of sequence.items) expect(item.id).toBe("one");
  });

  it("resumes a Collection search from its continuation with terse items", async () => {
    const odp = client(transport());
    for await (const item of odp.continueSearchCollections("/odp/collections/search?c=2").items)
      expect(item.id).toBe("one");
  });

  it("returns a Terse Offering from get-offering when asked for one", async () => {
    const odp = client(
      transportFor((url) =>
        url.pathname === "/.well-known/odp"
          ? response(service)
          : response({ odp_version: "1.0", id: "one", name: "One" })
      )
    );
    const terse = await odp.getOffering("one", { representation: "terse" });
    expect(terse.id).toBe("one");
  });
});

/** Consumes an async iterable for its side effects, without binding an unused loop variable. */
async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const item of iterable) void item;
}
