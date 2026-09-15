import { describe, expect, it, vi } from "vitest";

import {
  createDirectoryClient,
  DirectoryRequestError,
  type DirectorySearchPage,
  type DirectoryService,
  type DirectoryTransport
} from "../../src/index.js";

const service = {
  service_origin: "https://compute.example",
  name: "Compute",
  description: "GPU compute",
  language: "en",
  localizations: ["en"],
  operations: [
    { authentication: "not-required", name: "list-offerings" },
    { authentication: "not-required", name: "get-offering" }
  ],
  indexed_at: "2026-08-02T00:00:00Z"
};

function json(value: unknown, init: ResponseInit & { type?: string } = {}): Response {
  const { type = "application/json", headers, ...rest } = init;
  return new Response(JSON.stringify(value), {
    ...rest,
    headers: { "content-type": type, ...(headers as Record<string, string> | undefined) }
  });
}

function transportFor(handler: (url: URL, init: RequestInit) => Response): DirectoryTransport {
  return vi.fn((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(
      handler(new URL(input instanceof Request ? input.url : String(input)), init ?? {})
    )
  );
}

/** A directory result set of `total` Services served `perPage` at a time. */
function pagedDirectory(total: number, perPage: number) {
  let requests = 0;
  const transport = transportFor((url) => {
    requests += 1;
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const items = Array.from({ length: Math.min(perPage, total - offset) }, (_value, index) => ({
      ...service,
      service_origin: `https://s${String(offset + index)}.example`
    }));
    const next = offset + items.length;
    return json({
      items,
      ...(next >= total ? {} : { next: `/v1/services/search?offset=${String(next)}` })
    });
  });
  return { transport, requests: () => requests };
}

async function collect<Value>(iterable: AsyncIterable<Value>): Promise<Value[]> {
  const values: Value[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the directory request to fail");
}

describe("directory traversal", () => {
  it("follows a result set past sixteen pages", async () => {
    const directory = pagedDirectory(400, 10);
    const services = await collect(
      createDirectoryClient({ transport: directory.transport }).searchServices().items
    );
    // A 16-page ceiling silently discarded every Service past the 1,600th.
    expect(services).toHaveLength(400);
    expect(directory.requests()).toBe(40);
  });

  it("does not request another page once maxItems is reached on a page boundary", async () => {
    const directory = pagedDirectory(100, 10);
    const services = await collect(
      createDirectoryClient({ transport: directory.transport }).searchServices({}, { maxItems: 10 })
        .items
    );
    expect(services).toHaveLength(10);
    // Checking the budget before yielding let the enclosing loop pull page two first.
    expect(directory.requests()).toBe(1);
  });

  it("stops mid-page when maxItems falls inside one", async () => {
    const directory = pagedDirectory(100, 10);
    const services = await collect(
      createDirectoryClient({ transport: directory.transport }).searchServices({}, { maxItems: 4 })
        .items
    );
    expect(services).toHaveLength(4);
    expect(directory.requests()).toBe(1);
  });

  it("ends cleanly at the caller's maxPages and leaves the cursor visible", async () => {
    const directory = pagedDirectory(400, 10);
    const pages = await collect(
      createDirectoryClient({ transport: directory.transport }).searchServices({}, { maxPages: 3 })
        .pages
    );
    expect(pages).toHaveLength(3);
    expect(directory.requests()).toBe(3);
    // The truncation is discoverable: the last page still carries its continuation.
    expect(pages[2]?.next).toBeDefined();
  });

  it("reaches a maxItems well beyond the old sixteen-page ceiling", async () => {
    const directory = pagedDirectory(5_000, 100);
    const services = await collect(
      createDirectoryClient({ transport: directory.transport }).searchServices(
        {},
        { maxItems: 2_500 }
      ).items
    );
    // `maxItems` accepts up to 10,000 but could only ever yield 1,600.
    expect(services).toHaveLength(2_500);
  });

  it("detects a directory that repeats a continuation cursor", async () => {
    const transport = transportFor(() => json({ items: [service], next: "/v1/services/search" }));
    const failure = await failureOf(
      collect(createDirectoryClient({ transport }).searchServices().items)
    );
    expect(failure.message).toContain("pagination loop");
  });

  it("applies the same bounds when resuming a continuation", async () => {
    const directory = pagedDirectory(400, 10);
    const client = createDirectoryClient({ transport: directory.transport });
    const pages = await collect(
      client.continueSearchServices("/v1/services/search?offset=10", { maxPages: 2 }).pages
    );
    expect(pages).toHaveLength(2);
    const items = await collect(
      client.continueSearchServices("/v1/services/search?offset=10", { maxItems: 3 }).items
    );
    expect(items).toHaveLength(3);
  });

  it("rejects iteration bounds that are not positive integers", () => {
    const client = createDirectoryClient({ transport: transportFor(() => json({ items: [] })) });
    expect(() => client.searchServices({}, { maxPages: 0 })).toThrow("maxPages");
    expect(() => client.searchServices({}, { maxItems: 0 })).toThrow("maxItems");
    expect(() => client.searchServices({}, { maxPages: 1.5 })).toThrow("maxPages");
    expect(() => client.continueSearchServices("/v1/services/search", { maxItems: 0 })).toThrow(
      "maxItems"
    );
    expect(() => client.continueSearchServices("")).toThrow("next");
  });

  it("resumes a continuation with GET and no body", async () => {
    let seen: RequestInit | undefined;
    const transport = transportFor((_url, init) => {
      seen = init;
      return json({ items: [] });
    });
    await collect(
      createDirectoryClient({ transport }).continueSearchServices("/v1/services/search?c=1").pages
    );
    expect(seen?.method).toBe("GET");
    expect(seen?.body).toBeUndefined();
  });
});

describe("directory result parsing", () => {
  it("drops an unusable entry and reports it rather than failing the page", async () => {
    const transport = transportFor(() =>
      json({
        items: [
          service,
          { ...service, service_origin: "http://plain.example" },
          { ...service, service_origin: "https://other.example" }
        ]
      })
    );
    const [page] = await collect(createDirectoryClient({ transport }).searchServices().pages);
    // One stale entry used to reject the whole page and kill the traversal with it.
    expect(page?.items.map((item) => item.service_origin)).toEqual([
      "https://compute.example",
      "https://other.example"
    ]);
    expect(page?.issues).toHaveLength(1);
    expect(page?.issues?.[0]?.index).toBe(1);
    expect(page?.issues?.[0]?.message).toContain("HTTPS origin");
  });

  it("omits the issues member when every entry is usable", async () => {
    const transport = transportFor(() => json({ items: [service] }));
    const [page] = await collect(createDirectoryClient({ transport }).searchServices().pages);
    expect(page).not.toHaveProperty("issues");
  });

  it("still rejects a page whose envelope is malformed", async () => {
    for (const body of [{ items: "nope" }, { items: Array.from({ length: 101 }, () => service) }])
      await expect(
        collect(
          createDirectoryClient({ transport: transportFor(() => json(body)) }).searchServices()
            .pages
        )
      ).rejects.toThrow("items are invalid");
    await expect(
      collect(
        createDirectoryClient({ transport: transportFor(() => json([])) }).searchServices().pages
      )
    ).rejects.toThrow("must be an object");
  });

  it("refuses a Service origin on a private or loopback host", async () => {
    const hosts = [
      "https://localhost",
      "https://127.0.0.1",
      "https://10.1.2.3",
      "https://172.16.9.9",
      "https://192.168.0.5",
      "https://169.254.169.254",
      "https://100.100.0.1",
      "https://[::1]",
      "https://[::]",
      "https://[fc00::1]",
      "https://[fd00::1]",
      "https://[fe80::1]",
      "https://[fe90::1]",
      "https://[fea0::1]",
      "https://[feb0::1]",
      "https://app.localhost"
    ];
    for (const service_origin of hosts) {
      const transport = transportFor(() => json({ items: [{ ...service, service_origin }] }));
      const [page] = await collect(createDirectoryClient({ transport }).searchServices().pages);
      // The Agent's transport also blocks these, but that must not be the only thing that does.
      expect(page?.items).toEqual([]);
      expect(page?.issues?.[0]?.message).toContain("private or loopback");
    }
  });

  it("keeps an ordinary public Service origin", async () => {
    const transport = transportFor(() =>
      json({ items: [{ ...service, service_origin: "https://203.0.113.7" }] })
    );
    const [page] = await collect(createDirectoryClient({ transport }).searchServices().pages);
    expect(page?.items).toHaveLength(1);
  });

  it("rejects a Service origin that is not a canonical absolute HTTPS origin", async () => {
    const origins = [
      "not a url",
      "https://compute.example/",
      "https://compute.example/path",
      "https://user:pw@compute.example"
    ];
    for (const service_origin of origins) {
      const transport = transportFor(() => json({ items: [{ ...service, service_origin }] }));
      const [page] = await collect(createDirectoryClient({ transport }).searchServices().pages);
      expect(page?.items).toEqual([]);
    }
  });

  it("requires an RFC 3339 indexed_at", async () => {
    const usable = transportFor(() =>
      json({ items: [{ ...service, indexed_at: "2026-08-02T00:00:00.500+02:00" }] })
    );
    const [ok] = await collect(createDirectoryClient({ transport: usable }).searchServices().pages);
    expect(ok?.items).toHaveLength(1);

    // `Date.parse` accepts this, which is why the check needed to be a grammar and not a parse.
    const loose = transportFor(() =>
      json({ items: [{ ...service, indexed_at: "December 17, 1995 03:24:00" }] })
    );
    const [page] = await collect(
      createDirectoryClient({ transport: loose }).searchServices().pages
    );
    expect(page?.issues?.[0]?.message).toContain("RFC 3339");
  });

  it("does not pass through Service Document members it never validated", async () => {
    const transport = transportFor(() =>
      json({
        items: [
          {
            ...service,
            http: { endpoint_base: "https://attacker.example/collect" },
            odp_version: "9.9",
            mcp: [{ type: "streamable-http", url: "https://attacker.example/mcp" }],
            payment_origins: ["https://attacker.example"],
            search_capabilities: { filters: { inline: [] } },
            branding: { icon: { src: "/x.png" } },
            future_field: "kept"
          }
        ]
      })
    );
    const [page] = await collect(createDirectoryClient({ transport }).searchServices().pages);
    const result = page?.items[0] as DirectoryService & Record<string, unknown>;
    // `http.endpoint_base` is a real field a consumer could build URLs from; it was riding through
    // unvalidated next to fields that had been schema-checked.
    for (const member of [
      "http",
      "odp_version",
      "mcp",
      "payment_origins",
      "search_capabilities",
      "branding"
    ])
      expect(result).not.toHaveProperty(member);
    // Genuinely unknown members still pass through for forward compatibility.
    expect(result["future_field"]).toBe("kept");
  });

  it("never invokes an advertised MCP endpoint while indexing a result", async () => {
    const reached: string[] = [];
    const transport = transportFor((url) => {
      reached.push(url.origin);
      return json({
        items: [{ ...service, mcp: [{ type: "streamable-http", url: "https://mcp.example/" }] }]
      });
    });
    await collect(createDirectoryClient({ transport }).searchServices().pages);
    expect(reached).toEqual(["https://api.inflowpay.ai"]);
  });

  it("parses every facet shape the directory can return", async () => {
    const transport = transportFor(() =>
      json({
        items: [],
        facets: {
          keywords: [{ value: "gpu", count: 4 }],
          enrollment: [{ value: { name: "aep" }, count: 2 }],
          operations: [
            { value: { authentication: "not-required", name: "list-offerings" }, count: 7 }
          ],
          payments: [{ value: { authentication: "required", name: "mpp" }, count: 1 }],
          payment_options: [{ value: { name: "x402", option: "base" }, count: 3 }]
        }
      })
    );
    const [page] = await collect(createDirectoryClient({ transport }).searchServices().pages);
    expect(page?.facets?.keywords).toEqual([{ value: "gpu", count: 4 }]);
    expect(page?.facets?.enrollment?.[0]?.value).toEqual({ name: "aep" });
    expect(page?.facets?.operations?.[0]?.count).toBe(7);
    expect(page?.facets?.payments?.[0]?.value.name).toBe("mpp");
    expect(page?.facets?.payment_options?.[0]?.value).toEqual({ name: "x402", option: "base" });
  });

  it("rejects malformed facets", async () => {
    const bodies: Record<string, unknown>[] = [
      { facets: [] },
      { facets: { keywords: "no" } },
      { facets: { keywords: Array.from({ length: 101 }, () => ({ value: "a", count: 1 })) } },
      { facets: { keywords: [{ value: "a", count: -1 }] } },
      { facets: { enrollment: [{ value: { name: "other" }, count: 1 }] } },
      { facets: { enrollment: "no" } },
      { facets: { payments: [{ value: { authentication: "maybe", name: "mpp" }, count: 1 }] } },
      { facets: { payments: [{ value: { name: "mpp", extra: true }, count: 1 }] } },
      { facets: { payment_options: [{ value: { name: "mpp" }, count: 1 }] } },
      { facets: { payment_options: [{ value: { name: "mpp", option: "gold" }, count: 1 }] } },
      { facets: { operations: [{ value: { name: "list-offerings" }, count: 1 }] } },
      { facets: { operations: [{ value: { authentication: "no", name: "x" }, count: 1 }] } }
    ];
    for (const facets of bodies)
      await expect(
        collect(
          createDirectoryClient({
            transport: transportFor(() => json({ items: [], ...facets }))
          }).searchServices().pages
        )
      ).rejects.toThrow();
  });

  it("accepts a payment facet that carries options", async () => {
    const transport = transportFor(() =>
      json({
        items: [],
        facets: {
          payments: [
            { value: { authentication: "not-required", name: "mpp", options: ["base"] }, count: 1 }
          ]
        }
      })
    );
    const [page] = await collect(createDirectoryClient({ transport }).searchServices().pages);
    expect(page?.facets?.payments?.[0]?.value.options).toEqual(["base"]);
  });
});

describe("directory request validation", () => {
  function sentBody(handler: (body: Record<string, unknown>) => void): DirectoryTransport {
    return transportFor((_url, init) => {
      handler(
        JSON.parse(typeof init.body === "string" ? init.body : "{}") as Record<string, unknown>
      );
      return json({ items: [] });
    });
  }

  it("forwards only validated members of the request", async () => {
    let body: Record<string, unknown> = {};
    const transport = sentBody((value) => (body = value));
    await collect(
      createDirectoryClient({ transport }).searchServices({
        query: "gpu",
        limit: 25,
        ...({ unknown: "dropped" } as Record<string, unknown>)
      }).pages
    );
    expect(body).toEqual({ query: "gpu", limit: 25 });
  });

  it("accepts more operation and payment filters than there are protocol names", async () => {
    let body: Record<string, unknown> = {};
    const transport = sentBody((value) => (body = value));
    // The cap used to be the number of operations, but each one is filterable per authentication
    // value, so eight distinct filters were rejected as "invalid".
    await collect(
      createDirectoryClient({ transport }).searchServices({
        filters: {
          operations: [
            { name: "list-offerings", authentication: "not-required" },
            { name: "list-offerings", authentication: "optional" },
            { name: "list-offerings", authentication: "required" },
            { name: "get-offering", authentication: "not-required" },
            { name: "get-offering", authentication: "optional" },
            { name: "get-offering", authentication: "required" },
            { name: "search-offerings" },
            { name: "list-collections" }
          ],
          payments: [
            { name: "mpp", options: ["inflow"] },
            { name: "mpp", options: ["solana"] },
            { name: "x402" }
          ]
        }
      }).pages
    );
    const filters = body["filters"] as Record<string, unknown[]>;
    expect(filters["operations"]).toHaveLength(8);
    expect(filters["payments"]).toHaveLength(3);
  });

  it("rejects filters that are empty, duplicated, or carry unknown members", () => {
    const client = createDirectoryClient({ transport: transportFor(() => json({ items: [] })) });
    const invalid = [
      { operations: [] },
      { operations: [{ name: "not-an-operation" }] },
      { operations: [{ name: "get-offering", authentication: "maybe" }] },
      { operations: [{ name: "get-offering", extra: true }] },
      { operations: [{ name: "get-offering" }, { name: "get-offering" }] },
      { payments: [] },
      { payments: [{ name: "cash" }] },
      { payments: [{ name: "mpp", authentication: "optional" }] },
      { payments: [{ name: "mpp", extra: 1 }] },
      { payments: [{ name: "mpp", options: [] }] },
      { payments: [{ name: "mpp", options: ["gold"] }] },
      { payments: [{ name: "mpp", options: ["base", "base"] }] },
      { payments: [{ name: "mpp" }, { name: "mpp" }] },
      { enrollment: [] },
      { enrollment: [{ name: "other" }] },
      { enrollment: [{ name: "aep", extra: 1 }] },
      { keywords: [] },
      { keywords: ["a", "a"] },
      { keywords: [" "] },
      { keywords: [1] }
    ];
    for (const filters of invalid)
      expect(() =>
        client.searchServices({ filters } as Parameters<typeof client.searchServices>[0])
      ).toThrow();
  });

  it("rejects a query or limit outside its bounds", () => {
    const client = createDirectoryClient({ transport: transportFor(() => json({ items: [] })) });
    expect(() => client.searchServices({ query: "" })).toThrow("query");
    expect(() => client.searchServices({ query: "x".repeat(513) })).toThrow("query");
    expect(() => client.searchServices({ limit: 101 })).toThrow("limit");
    expect(() => client.searchServices({ limit: 0 })).toThrow("limit");
  });

  it("forwards a validated enrollment filter", async () => {
    let body: Record<string, unknown> = {};
    const transport = sentBody((value) => (body = value));
    await collect(
      createDirectoryClient({ transport }).searchServices({
        filters: { enrollment: [{ name: "aep" }] }
      }).pages
    );
    expect(body["filters"]).toEqual({ enrollment: [{ name: "aep" }] });
  });
});

describe("directory suggestions", () => {
  it("bounds and de-duplicates whatever the server returns", async () => {
    const transport = transportFor(() =>
      json({ items: [...Array.from({ length: 40 }, (_v, i) => `s${String(i)}`), "s0"] })
    );
    const suggestions = await createDirectoryClient({ transport }).suggestServices({ prefix: "s" });
    // The client never sent a limit, so asserting one and throwing was its own bug.
    expect(suggestions).toHaveLength(25);
    expect(new Set(suggestions).size).toBe(25);
  });

  it("collapses duplicates without failing", async () => {
    const transport = transportFor(() => json({ items: ["gpu", "gpu", "gpus"] }));
    const suggestions = await createDirectoryClient({ transport }).suggestServices({ prefix: "g" });
    expect(suggestions).toEqual(["gpu", "gpus"]);
  });

  it("sends the prefix and an explicit limit", async () => {
    let requested: URL | undefined;
    const transport = transportFor((url) => {
      requested = url;
      return json({ items: [] });
    });
    await createDirectoryClient({ transport }).suggestServices({ prefix: "gp", limit: 10 });
    expect(requested?.pathname).toBe("/v1/services/suggestions");
    expect(requested?.searchParams.get("prefix")).toBe("gp");
    expect(requested?.searchParams.get("limit")).toBe("10");
  });

  it("rejects an unusable prefix, limit, or payload", async () => {
    const client = createDirectoryClient({ transport: transportFor(() => json({ items: [] })) });
    await expect(client.suggestServices({ prefix: "" })).rejects.toThrow("prefix");
    await expect(client.suggestServices({ prefix: "g", limit: 26 })).rejects.toThrow("limit");
    await expect(
      createDirectoryClient({
        transport: transportFor(() => json({ items: "no" }))
      }).suggestServices({ prefix: "g" })
    ).rejects.toThrow("suggestions");
    await expect(
      createDirectoryClient({
        transport: transportFor(() => json({ items: [""] }))
      }).suggestServices({ prefix: "g" })
    ).rejects.toThrow("suggestions");
  });

  it("honours an abort signal on the suggestion request", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | null | undefined;
    const transport = transportFor((_url, init) => {
      seen = init.signal;
      return json({ items: [] });
    });
    await createDirectoryClient({ transport }).suggestServices({
      prefix: "g",
      signal: controller.signal
    });
    expect(seen).toBe(controller.signal);
  });
});

describe("directory HTTP layer", () => {
  it("follows five same-origin redirects and refuses a sixth", async () => {
    const build = (limit: number): DirectoryTransport =>
      transportFor((url) => {
        const hop = Number(url.searchParams.get("hop") ?? "0");
        if (hop >= limit) return json({ items: [] });
        return new Response(null, {
          status: 307,
          headers: { location: `/v1/services/search?hop=${String(hop + 1)}` }
        });
      });
    await expect(
      collect(createDirectoryClient({ transport: build(5) }).searchServices().pages)
    ).resolves.toHaveLength(1);
    const failure = await failureOf(
      collect(createDirectoryClient({ transport: build(6) }).searchServices().pages)
    );
    expect(failure.message).toContain("redirect limit");
  });

  it("keeps the abort signal across a redirect that changes the method", async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | null | undefined)[] = [];
    const transport = transportFor((url, init) => {
      seen.push(init.signal);
      if (url.searchParams.has("moved")) return json({ items: [] });
      return new Response(null, {
        status: 303,
        headers: { location: "/v1/services/search?moved=1" }
      });
    });
    await collect(
      createDirectoryClient({ transport }).searchServices({}, { signal: controller.signal }).pages
    );
    // Rebuilding the GET from scratch dropped the signal, so the rest of the chain could not be
    // cancelled — and a directory that always answers 303 made every search unabortable.
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(controller.signal);
  });

  it("drops the body and content-type when a POST redirect becomes a GET", async () => {
    const seen: RequestInit[] = [];
    const transport = transportFor((url, init) => {
      seen.push(init);
      if (url.searchParams.has("moved")) return json({ items: [] });
      return new Response(null, {
        status: 302,
        headers: { location: "/v1/services/search?moved=1" }
      });
    });
    await collect(createDirectoryClient({ transport }).searchServices({ query: "gpu" }).pages);
    expect(seen[1]?.method).toBe("GET");
    expect(seen[1]?.body).toBeUndefined();
    expect(new Headers(seen[1]?.headers).get("content-type")).toBeNull();
  });

  it("preserves the method and body across a 307", async () => {
    const seen: RequestInit[] = [];
    const transport = transportFor((url, init) => {
      seen.push(init);
      if (url.searchParams.has("moved")) return json({ items: [] });
      return new Response(null, {
        status: 307,
        headers: { location: "/v1/services/search?moved=1" }
      });
    });
    await collect(createDirectoryClient({ transport }).searchServices({ query: "gpu" }).pages);
    expect(seen[1]?.method).toBe("POST");
    expect(seen[1]?.body).toBe(JSON.stringify({ query: "gpu" }));
  });

  it("refuses a redirect that leaves the canonical origin or omits its target", async () => {
    const offOrigin = transportFor(
      () => new Response(null, { status: 301, headers: { location: "https://evil.example/x" } })
    );
    await expect(
      collect(createDirectoryClient({ transport: offOrigin }).searchServices().pages)
    ).rejects.toThrow("changed origin");
    const headless = transportFor(() => new Response(null, { status: 308 }));
    await expect(
      collect(createDirectoryClient({ transport: headless }).searchServices().pages)
    ).rejects.toThrow("omitted Location");
  });

  it("bounds and sanitizes an error body before it becomes a message", async () => {
    const escape = String.fromCharCode(27);
    const hostile = `${escape}[2Jvisit https://evil.example ${"x".repeat(5_000)}`;
    const transport = transportFor(
      () =>
        new Response(JSON.stringify({ detail: hostile }), {
          status: 500,
          headers: { "content-type": "application/json" }
        })
    );
    const failure = (await failureOf(
      collect(createDirectoryClient({ transport }).searchServices().pages)
    )) as DirectoryRequestError;
    expect(failure).toBeInstanceOf(DirectoryRequestError);
    // The whole body used to become the message verbatim, terminal escapes and all.
    expect(failure.message).not.toContain(escape);
    expect(failure.message.length).toBeLessThan(2_200);
    expect(failure.message).toContain("visit https://evil.example");
    expect(failure.message.endsWith("\u2026")).toBe(true);
  });

  it("gives up on an error body larger than the error read budget", async () => {
    const transport = transportFor(
      () =>
        new Response(JSON.stringify({ detail: "x".repeat(20_000) }), {
          status: 500,
          headers: { "content-type": "application/json" }
        })
    );
    const failure = await failureOf(
      collect(createDirectoryClient({ transport }).searchServices().pages)
    );
    expect(failure.message).toBe("Directory request failed with HTTP 500");
  });

  it("ignores an error body that does not claim to be JSON", async () => {
    const transport = transportFor(
      () =>
        new Response("<html><body>gateway error</body></html>", {
          status: 502,
          headers: { "content-type": "text/html" }
        })
    );
    const failure = (await failureOf(
      collect(createDirectoryClient({ transport }).searchServices().pages)
    )) as DirectoryRequestError;
    expect(failure.message).toBe("Directory request failed with HTTP 502");
    expect(failure.status).toBe(502);
  });

  it("falls back to an excerpt when a JSON error body has no recognized member", async () => {
    const transport = transportFor(
      () =>
        new Response('{"weird": true}', {
          status: 400,
          headers: { "content-type": "application/json" }
        })
    );
    const failure = await failureOf(
      collect(createDirectoryClient({ transport }).searchServices().pages)
    );
    expect(failure.message).toContain('{"weird": true}');
  });

  it("reads a problem+json error body", async () => {
    const transport = transportFor(
      () =>
        new Response(JSON.stringify({ title: "Rate limited" }), {
          status: 429,
          headers: { "content-type": "application/problem+json" }
        })
    );
    const failure = (await failureOf(
      collect(createDirectoryClient({ transport }).searchServices().pages)
    )) as DirectoryRequestError;
    expect(failure.message).toContain("Rate limited");
    expect(failure.retryable).toBe(true);
    expect(failure.code).toBe("HTTP_ERROR");
  });

  it("marks server failures retryable and client failures not", async () => {
    const failureFor = async (status: number): Promise<DirectoryRequestError> =>
      (await failureOf(
        collect(
          createDirectoryClient({
            transport: transportFor(() => new Response(null, { status }))
          }).searchServices().pages
        )
      )) as DirectoryRequestError;
    expect((await failureFor(503)).retryable).toBe(true);
    expect((await failureFor(429)).retryable).toBe(true);
    expect((await failureFor(404)).retryable).toBe(false);
  });

  it("tolerates an error body it cannot read", async () => {
    const transport = transportFor(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("stream broke"));
            }
          }),
          { status: 500, headers: { "content-type": "application/json" } }
        )
    );
    const failure = await failureOf(
      collect(createDirectoryClient({ transport }).searchServices().pages)
    );
    expect(failure.message).toBe("Directory request failed with HTTP 500");
  });

  it("rejects a success response that is not JSON, or is not valid JSON", async () => {
    const wrongType = transportFor(() => json({ items: [] }, { type: "text/plain" }));
    await expect(
      collect(createDirectoryClient({ transport: wrongType }).searchServices().pages)
    ).rejects.toThrow("must use application/json");
    const notJson = transportFor(
      () => new Response("{oops", { headers: { "content-type": "application/json" } })
    );
    await expect(
      collect(createDirectoryClient({ transport: notJson }).searchServices().pages)
    ).rejects.toThrow("valid JSON");
  });

  it("rejects a body whose declared length exceeds the limit", async () => {
    const transport = transportFor(
      () =>
        new Response("{}", {
          headers: { "content-type": "application/json", "content-length": "999999" }
        })
    );
    await expect(
      collect(createDirectoryClient({ transport }).searchServices().pages)
    ).rejects.toThrow("byte limit");
  });

  it("accepts a response with no body at all", async () => {
    const transport = transportFor(
      () => new Response(null, { headers: { "content-type": "application/json" } })
    );
    await expect(
      collect(createDirectoryClient({ transport }).searchServices().pages)
    ).rejects.toThrow("valid JSON");
  });

  it("sends the accept header and a JSON content type for the search POST", async () => {
    let seen: Headers | undefined;
    const transport = transportFor((_url, init) => {
      seen = new Headers(init.headers);
      return json({ items: [] });
    });
    await collect(createDirectoryClient({ transport }).searchServices().pages);
    expect(seen?.get("accept")).toBe("application/json");
    expect(seen?.get("content-type")).toBe("application/json");
  });

  it("propagates an abort signal to the search request", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | null | undefined;
    const transport = transportFor((_url, init) => {
      seen = init.signal;
      return json({ items: [] });
    });
    await collect(
      createDirectoryClient({ transport }).searchServices({}, { signal: controller.signal }).pages
    );
    expect(seen).toBe(controller.signal);
  });
});

describe("directory results are candidate metadata", () => {
  it("records when the entry was indexed so a caller can judge staleness", async () => {
    const transport = transportFor(() => json({ items: [service] }));
    const [page] = await collect(createDirectoryClient({ transport }).searchServices().pages);
    const first: DirectorySearchPage | undefined = page;
    expect(first?.items[0]?.indexed_at).toBe("2026-08-02T00:00:00Z");
    // A directory result is a candidate, never authoritative catalog data: it carries no Offering,
    // Collection or endpoint information an Agent could act on without inspecting the Service.
    for (const member of ["items", "offerings", "collections", "http"])
      expect(first?.items[0]).not.toHaveProperty(member);
  });
});

describe("directory client construction and guards", () => {
  it("defaults to the platform fetch and the production origin", () => {
    // Constructing without a transport must not throw; the default is only called on use.
    const client = createDirectoryClient();
    expect(client.environment).toBe("production");
  });

  it("passes an abort signal down a continuation traversal", async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | null | undefined)[] = [];
    let page = 0;
    const transport = transportFor((_url, init) => {
      seen.push(init.signal);
      page += 1;
      return json({ items: [], ...(page >= 2 ? {} : { next: "/v1/services/search?p=2" }) });
    });
    await collect(
      createDirectoryClient({ transport }).continueSearchServices("/v1/services/search?p=1", {
        signal: controller.signal
      }).pages
    );
    expect(seen).toEqual([controller.signal, controller.signal]);
  });

  it("survives a redirect body that cannot be released", async () => {
    const transport = transportFor((url) => {
      if (url.searchParams.has("moved")) return json({ items: [] });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("redirect body"));
          controller.close();
        }
      });
      const redirect = new Response(body, {
        status: 307,
        headers: { location: "/v1/services/search?moved=1" }
      });
      // Locking the stream makes `cancel()` throw, which must not become the caller's error.
      redirect.body?.getReader();
      return redirect;
    });
    await expect(
      collect(createDirectoryClient({ transport }).searchServices().pages)
    ).resolves.toHaveLength(1);
  });
});
