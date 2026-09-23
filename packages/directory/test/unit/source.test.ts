import { describe, expect, it, vi } from "vitest";
import { createDirectoryClient, type DirectoryServiceFilters } from "../../src/index.js";

const source = {
  type: "openapi",
  url: "https://docs.example.com/v1/OpenAPI.json?revision=2",
  x402_discovery: false
};
const service = {
  service_id: "imported",
  service_origin: "https://api.example.com",
  name: "Search",
  indexed_at: "2026-09-23T00:00:00Z",
  source
};
const result = { type: "service", service, indexed_at: service.indexed_at };

async function collect<Value>(values: AsyncIterable<Value>): Promise<Value[]> {
  const result: Value[] = [];
  for await (const value of values) result.push(value);
  return result;
}

function inputUrl(input: string | Request | URL | undefined): string {
  return input instanceof Request ? input.url : String(input);
}

function clientFor(items: unknown[]) {
  const transport = vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(Response.json({ items })));
  return { client: createDirectoryClient({ transport }), transport };
}

describe("source-aware Directory discovery", () => {
  it("preserves exact source URLs and omitted metadata for Services and derived Collections", async () => {
    const collection = {
      ...result,
      type: "collection",
      collection: { id: "group-1", name: "Search tools" }
    };
    const { client, transport } = clientFor([result, collection]);
    expect(await collect(client.search().pages)).toEqual([{ items: [result, collection] }]);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(inputUrl(transport.mock.calls[0]?.[0])).toBe(
      "https://api.inflowpay.ai/v1/directory/search"
    );
  });

  it("retains imported metadata and known protocols without exposing unvalidated ODP fields", async () => {
    const metadata = {
      description: "",
      documentation_url: "https://docs.example.com/",
      language: "en",
      localizations: ["en"],
      keywords: ["search"],
      status_url: "https://status.example.com/",
      support_url: "https://example.com/support",
      website_url: "https://example.com/",
      extra: 1,
      protocols: {
        enrollment: [{ name: "aep" }],
        payments: [{ name: "x402", authentication: "not-required", options: ["solana"] }],
        trust: [{ name: "tap" }]
      }
    };
    const poisoned = {
      ...service,
      ...metadata,
      source: { ...source, x402_discovery: true, extra: 1 },
      operations: [{ name: "get-offering" }],
      http: { endpoint_base: "https://bad.example" },
      mcp: [],
      odp_version: "1.0",
      branding: {},
      payment_origins: [],
      search_capabilities: {}
    };
    const { client } = clientFor([{ ...result, service: poisoned }]);
    expect(await collect(client.search().items)).toEqual([
      { ...result, service: { ...service, ...metadata, source: poisoned.source } }
    ]);
  });

  it("keeps unfamiliar source formats displayable without treating them as ODP", async () => {
    const item = {
      ...result,
      service: {
        ...service,
        source: { ...source, type: "future" },
        protocols: {
          enrollment: [{ name: "future" }],
          payments: [{ name: "future" }],
          trust: [{ name: "future" }]
        }
      }
    };
    const { client } = clientFor([item]);
    expect(await collect(client.search().items)).toEqual([
      {
        ...item,
        service: { ...item.service, protocols: {} }
      }
    ]);
    const empty = { ...result, service: { ...service, protocols: {} } };
    expect(await collect(clientFor([empty]).client.search().items)).toEqual([empty]);
  });

  it("isolates invalid source records without inferring a source for missing metadata", async () => {
    const invalid = [
      undefined,
      null,
      [],
      {},
      { ...source, type: "" },
      { ...source, type: 1 },
      ...[
        undefined,
        null,
        "",
        "relative.json",
        "http://example.com/api.json",
        "https://user@example.com/api.json",
        "https://example.com/a#",
        "https://localhost/a",
        "https://127.0.0.1/a"
      ].map((url) => ({ ...source, url })),
      ...[undefined, null, "false", 1].map((x402_discovery) => ({ ...source, x402_discovery }))
    ];
    const { client } = clientFor([
      ...invalid.map((source) => ({ ...result, service: { ...service, source } })),
      result
    ]);
    const [page] = await collect(client.search().pages);
    expect(page?.items).toEqual([result]);
    expect(page?.issues?.map((issue) => issue.index)).toEqual(invalid.map((_, index) => index));
  });

  it("rejects malformed imported fields and recognized protocol descriptors", async () => {
    const invalid = [
      { service_id: "" },
      { service_origin: "https://localhost" },
      { name: undefined },
      { indexed_at: "bad" },
      ...[
        "description",
        "documentation_url",
        "language",
        "status_url",
        "support_url",
        "website_url"
      ].map((field) => ({ [field]: null })),
      ...["keywords", "localizations"].flatMap((field) =>
        [null, "en", [null]].map((value) => ({ [field]: value }))
      ),
      ...[
        null,
        [],
        { payments: null },
        { enrollment: "aep" },
        { trust: [null] },
        { payments: [{}] },
        { payments: [{ name: "x402" }] },
        { enrollment: [{ name: "aep" }, { name: "aep" }] },
        { enrollment: [{ name: "aep", invalid: true }] },
        { trust: [{ name: "tap", invalid: true }] }
      ].map((protocols) => ({ protocols }))
    ];
    const [page] = await collect(
      clientFor([
        ...invalid.map((value) => ({ ...result, service: { ...service, ...value } })),
        result
      ]).client.search().pages
    );
    expect(page?.items).toEqual([result]);
    expect(page?.issues).toHaveLength(invalid.length);
  });

  it("retains both supported payment protocols", async () => {
    const item = {
      ...result,
      service: {
        ...service,
        protocols: {
          payments: [
            { name: "mpp", authentication: "required" },
            { name: "x402", authentication: "not-required" }
          ]
        }
      }
    };
    expect(await collect(clientFor([item]).client.search().items)).toEqual([item]);
  });

  it("keeps native ODP validation strict in mixed and Service-only search", async () => {
    const native = { ...service, source: { ...source, type: "odp" } };
    const { client } = clientFor([{ ...result, service: native }]);
    const [mixed] = await collect(client.search().pages);
    expect(mixed?.items).toEqual([]);
    expect(mixed?.issues).toHaveLength(1);
    const [legacy] = await collect(clientFor([service]).client.searchServices().pages);
    expect(legacy?.items).toEqual([]);
    expect(legacy?.issues).toHaveLength(1);
  });

  it("parses imported records on continuation without fetching source documents", async () => {
    const { client, transport } = clientFor([result]);
    expect(await collect(client.continueSearch("/v1/directory/search?cursor=2").items)).toEqual([
      result
    ]);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it("copies source filters and sends them on mixed search, native search and suggestions", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation((input) =>
        Promise.resolve(
          Response.json({ items: inputUrl(input).includes("suggestions") ? ["Weather"] : [] })
        )
      );
    const client = createDirectoryClient({ transport });
    const filters: DirectoryServiceFilters = { sources: ["openapi"], payments: [{ name: "x402" }] };
    const sequence = client.search({ filters });
    filters.sources?.splice(0);
    await collect(sequence.items);
    const body = transport.mock.calls[0]?.[1]?.body;
    expect(typeof body === "string" ? JSON.parse(body) : null).toEqual({
      filters: { sources: ["openapi"], payments: [{ name: "x402" }] }
    });
    for (const sources of [["odp"], ["openapi"], ["odp", "openapi"]] satisfies NonNullable<
      DirectoryServiceFilters["sources"]
    >[]) {
      await collect(client.searchServices({ filters: { sources } }).items);
      expect(await client.suggest({ prefix: "we", filters: { sources } })).toEqual(["Weather"]);
      const body = transport.mock.lastCall?.[1]?.body;
      expect(typeof body === "string" ? JSON.parse(body) : null).toEqual({
        prefix: "we",
        filters: { sources }
      });
    }
  });

  it("rejects invalid source filters before sending a request", async () => {
    const { client, transport } = clientFor([]);
    for (const sources of [
      null,
      "odp",
      [],
      ["ODP"],
      ["future"],
      ["odp", "odp"],
      ["odp", "openapi", "future"]
    ]) {
      // Exercise untyped JavaScript input at the public boundary.
      const filters = { sources } as DirectoryServiceFilters;
      expect(() => client.search({ filters })).toThrow("sources");
      expect(() => client.searchServices({ filters })).toThrow("sources");
      await expect(client.suggest({ prefix: "we", filters })).rejects.toThrow("sources");
    }
    expect(transport).not.toHaveBeenCalled();
  });
});
