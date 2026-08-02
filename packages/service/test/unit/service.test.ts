import { describe, expect, it, vi } from "vitest";

import { createOdpService, createStaticCatalog, type OdpCatalog } from "../../src/index.js";

const offerings = [
  {
    odp_version: "1.0" as const,
    id: "gpu-h100",
    name: "H100 GPU",
    description: "Dedicated accelerator",
    attributes: { memory: 80 },
    schema: { url: "/schemas/gpu.json" },
    actions: [{ id: "rent", rel: "purchase", http: { href: "/rent", method: "POST" as const } }]
  },
  { odp_version: "1.0" as const, id: "storage", name: "Storage" }
];

function service(catalog: OdpCatalog = createStaticCatalog({ offerings })) {
  return createOdpService({
    catalog,
    document: {
      name: "Example",
      description: "Example catalog",
      language: "en",
      localizations: ["en"],
      http: { endpoint_base: "/odp" }
    }
  });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("ODP Service", () => {
  it("derives baseline operations and serves the well-known document", async () => {
    const odp = service();
    expect(odp.document.operations.supported).toEqual(["get-offering", "list-offerings"]);
    const response = await odp.fetch(new Request("https://example.com/.well-known/odp"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/odp+json");
    await expect(response.json()).resolves.toMatchObject({ name: "Example" });
  });

  it("uses terse list and full retrieval defaults", async () => {
    const odp = service();
    const list = await body(await odp.fetch(new Request("https://example.com/odp/offerings")));
    const first = (list["items"] as Record<string, unknown>[])[0];
    expect(first).not.toHaveProperty("actions");
    expect(first).not.toHaveProperty("attributes");

    const detail = await body(
      await odp.fetch(new Request("https://example.com/odp/offerings/gpu-h100"))
    );
    expect(detail).toHaveProperty("actions");
    expect(detail).toHaveProperty("attributes.memory", 80);
  });

  it("provides stable static-catalog continuation links", async () => {
    const odp = service();
    const first = await body(
      await odp.fetch(new Request("https://example.com/odp/offerings?limit=1"))
    );
    expect(first["next"]).toMatch(
      /^\/odp\/offerings\?cursor=[0-9a-f-]+&representation=terse&limit=1$/u
    );
    const second = await body(
      await odp.fetch(new Request(`https://example.com${String(first["next"])}`))
    );
    expect((second["items"] as Record<string, unknown>[])[0]?.["id"]).toBe("storage");
  });

  it("derives optional operations and supports GET search continuations", async () => {
    const search = vi.fn((query) =>
      Promise.resolve({
        odp_version: "1.0" as const,
        items:
          query === undefined
            ? [{ odp_version: "1.0" as const, id: "storage", name: "Storage" }]
            : [{ odp_version: "1.0" as const, id: "gpu-h100", name: "H100 GPU" }],
        ...(query === undefined ? {} : { next: "/odp/offerings/search?cursor=opaque" })
      })
    );
    const catalog: OdpCatalog = {
      listOfferings: () => ({ odp_version: "1.0", items: [] }),
      getOffering: () => undefined,
      searchOfferings: search
    };
    const odp = service(catalog);
    expect(odp.document.operations.supported).toContain("search-offerings");
    const initial = await odp.fetch(
      new Request("https://example.com/odp/offerings/search", {
        method: "POST",
        headers: { "content-type": "application/odp+json" },
        body: JSON.stringify({ odp_version: "1.0", query: "gpu", limit: 1 })
      })
    );
    expect(initial.status).toBe(200);
    const continuation = await odp.fetch(
      new Request("https://example.com/odp/offerings/search?cursor=opaque")
    );
    expect(continuation.status).toBe(200);
    expect(search).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ query: "gpu", limit: 1 }),
      expect.objectContaining({ limit: 1, representation: "terse" })
    );
    expect(search).toHaveBeenNthCalledWith(
      2,
      undefined,
      expect.objectContaining({ cursor: "opaque", representation: "terse" })
    );
  });

  it("returns bounded Problem Details for invalid requests", async () => {
    const response = await service().fetch(
      new Request("https://example.com/odp/offerings?representation=terse&representation=full")
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
  });

  it("does not materialize marketplace catalogs in the Service runtime", async () => {
    const listOfferings: OdpCatalog["listOfferings"] = vi.fn(
      ({ cursor, limit = 50 }: Parameters<OdpCatalog["listOfferings"]>[0]) => {
        const offset = cursor === undefined ? 0 : Number(cursor.slice(1));
        const count = Math.min(limit, 10_000_000 - offset);
        return {
          odp_version: "1.0" as const,
          items: Array.from({ length: count }, (_, index) => ({
            id: `offering-${offset + index}`,
            name: `Offering ${offset + index}`
          })),
          ...(offset + count >= 10_000_000
            ? {}
            : { next: `/odp/offerings?cursor=c${offset + count}&limit=${limit}` })
        };
      }
    );
    const odp = service({
      listOfferings,
      getOffering: (id) => ({ odp_version: "1.0", id, name: id })
    });
    const response = await body(
      await odp.fetch(new Request("https://example.com/odp/offerings?limit=3"))
    );
    expect((response["items"] as unknown[]).length).toBe(3);
    expect(response["next"]).toBe("/odp/offerings?cursor=c3&limit=3");
    expect(listOfferings).toHaveBeenCalledOnce();
  });

  it("negotiates response media types and maps malformed search input", async () => {
    const odp = service({
      listOfferings: () => ({ odp_version: "1.0", items: [] }),
      getOffering: () => undefined,
      searchOfferings: () => ({ odp_version: "1.0", items: [] })
    });
    const unacceptable = await odp.fetch(
      new Request("https://example.com/odp/offerings", { headers: { accept: "text/html" } })
    );
    expect(unacceptable.status).toBe(406);
    const invalid = await odp.fetch(
      new Request("https://example.com/odp/offerings/search", {
        method: "POST",
        headers: { "content-type": "application/odp+json" },
        body: "{}"
      })
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
