import { describe, expect, it, vi } from "vitest";

import { resolveSearchCapabilities } from "../../src/capabilities.js";
import type { ServiceInspection } from "../../src/index.js";

const filter = {
  id: "region",
  title: "Region",
  description: "Deployment region",
  type: "string" as const,
  operators: ["eq" as const]
};

function inspection(
  search_capabilities: ServiceInspection["document"]["search_capabilities"]
): ServiceInspection {
  return {
    requestedUrl: new URL("https://example.com/.well-known/odp"),
    finalUrl: new URL("https://example.com/.well-known/odp"),
    serviceOrigin: "https://example.com",
    freshness: "fetched",
    capabilities: {
      enrollment: [],
      operations: [
        { authentication: "not-required", name: "list-offerings" },
        { authentication: "not-required", name: "get-offering" },
        { authentication: "not-required", name: "search-offerings" }
      ],
      payments: [],
      trust: []
    },
    document: {
      odp_version: "1.0",
      name: "Example",
      description: "Example",
      language: "en",
      localizations: ["en"],
      operations: [
        { authentication: "not-required", name: "list-offerings" },
        { authentication: "not-required", name: "get-offering" },
        { authentication: "not-required", name: "search-offerings" }
      ],
      http: { endpoint_base: "/odp" },
      ...(search_capabilities === undefined ? {} : { search_capabilities })
    }
  };
}

describe("search capability resolution", () => {
  it("quarantines duplicate identifiers across scopes", async () => {
    const result = await resolveSearchCapabilities({
      inspection: inspection({ filters: { inline: [filter] } }),
      collection: { filters: { inline: [filter] } },
      loadPage: vi.fn()
    });
    expect(result.filters.has("region")).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({ scope: "collection", kind: "filters" })
    ]);
  });

  it("omits sorts that reference unavailable filters", async () => {
    const result = await resolveSearchCapabilities({
      inspection: inspection(undefined),
      collection: {
        sorts: {
          inline: [
            {
              id: "unknown-order",
              title: "Unknown",
              description: "Unknown filter order",
              keys: [{ filter_id: "unknown", direction: "ascending", missing: "last" }]
            }
          ]
        }
      },
      loadPage: vi.fn()
    });
    expect(result.sorts.size).toBe(0);
    expect(result.issues[0]?.message).toContain("unavailable filter");
  });

  it("discards a linked source that attempts a seventeenth page", async () => {
    const loadPage = vi.fn((_kind: "filters" | "sorts", href: string) => {
      const number = Number(href.slice(2));
      return Promise.resolve({
        odp_version: "1.0" as const,
        items: [filter],
        next: `/p${number + 1}`
      });
    });
    const result = await resolveSearchCapabilities({
      inspection: inspection({ filters: { linked: { href: "/p1" } } }),
      collection: undefined,
      loadPage
    });
    expect(loadPage).toHaveBeenCalledTimes(16);
    expect(result.filters.size).toBe(0);
    expect(result.issues[0]?.message).toContain("exceeded 16 pages");
  });
  it("keeps an earlier valid source when a later one overflows the effective catalog", async () => {
    const many = Array.from({ length: 1_100 }, (_value, index) => ({
      ...filter,
      id: `f${String(index)}`
    }));
    const result = await resolveSearchCapabilities({
      inspection: inspection({ filters: { inline: [filter] } }),
      collection: { filters: { inline: many } },
      loadPage: vi.fn()
    });
    // The overflowing source is discarded whole; the Service-wide source it followed survives.
    expect(result.filters.size).toBe(1);
    expect(result.filters.has("region")).toBe(true);
    expect(result.issues[0]?.message).toContain("exceed their limit");
  });

  it("does not let an overflowing source strip an identifier from an earlier one", async () => {
    const many = [
      filter,
      ...Array.from({ length: 1_100 }, (_value, index) => ({ ...filter, id: `f${String(index)}` }))
    ];
    const result = await resolveSearchCapabilities({
      inspection: inspection({ filters: { inline: [filter] } }),
      collection: { filters: { inline: many } },
      loadPage: vi.fn()
    });
    // Deleting the cross-source duplicate before the bound was checked used to remove `region`
    // even though the source that collided with it was then thrown away.
    expect(result.filters.has("region")).toBe(true);
  });

  it("invalidates a whole source that repeats an identifier within itself", async () => {
    const result = await resolveSearchCapabilities({
      inspection: inspection(undefined),
      collection: {
        filters: { inline: [filter, { ...filter, id: "zone" }, { ...filter }] }
      },
      loadPage: vi.fn()
    });
    // A source is atomic: a repeat inside it invalidates the source rather than one identifier.
    expect(result.filters.size).toBe(0);
    expect(result.issues[0]?.message).toContain("within one source");
  });

  it("stops paging a linked source as soon as it cannot fit the effective catalog", async () => {
    const page = Array.from({ length: 100 }, (_value, index) => ({
      ...filter,
      id: `p${String(index)}`
    }));
    let served = 0;
    const loadPage = vi.fn((_kind: "filters" | "sorts", href: string) => {
      served += 1;
      const number = Number(href.slice(2));
      return Promise.resolve({
        odp_version: "1.0" as const,
        items: page.map((entry) => ({ ...entry, id: `${entry.id}-${String(number)}` })),
        next: `/p${number + 1}`
      });
    });
    const result = await resolveSearchCapabilities({
      inspection: inspection({ filters: { linked: { href: "/p1" } } }),
      collection: undefined,
      loadPage
    });
    // 1,024 is the bound, so paging must stop on the eleventh page rather than buffering all 16.
    expect(served).toBe(11);
    expect(result.issues[0]?.message).toContain("exceed their limit");
  });

  it("rejects a linked page that carries more than one hundred definitions", async () => {
    const loadPage = vi.fn(() =>
      Promise.resolve({
        odp_version: "1.0" as const,
        items: Array.from({ length: 101 }, (_value, index) => ({
          ...filter,
          id: `f${String(index)}`
        }))
      })
    );
    const result = await resolveSearchCapabilities({
      inspection: inspection({ filters: { linked: { href: "/p1" } } }),
      collection: undefined,
      loadPage
    });
    expect(result.filters.size).toBe(0);
    expect(result.issues[0]?.message).toContain("more than 100");
  });

  it("detects a linked source that loops back on itself", async () => {
    const loadPage = vi.fn(() =>
      Promise.resolve({ odp_version: "1.0" as const, items: [filter], next: "/p1" })
    );
    const result = await resolveSearchCapabilities({
      inspection: inspection({ filters: { linked: { href: "/p1" } } }),
      collection: undefined,
      loadPage
    });
    expect(result.issues[0]?.message).toContain("pagination loop");
  });

  it("completes a linked source that ends before the page limit", async () => {
    const loadPage = vi.fn(() => Promise.resolve({ odp_version: "1.0" as const, items: [filter] }));
    const result = await resolveSearchCapabilities({
      inspection: inspection({ filters: { linked: { href: "/p1" } } }),
      collection: undefined,
      loadPage
    });
    expect(result.filters.get("region")?.title).toBe("Region");
    expect(result.issues).toEqual([]);
  });

  it("reports a capability source advertised without the search-offerings operation", async () => {
    const base = inspection({ filters: { inline: [filter] } });
    const withoutSearch: ServiceInspection = {
      ...base,
      capabilities: {
        ...base.capabilities,
        operations: base.capabilities.operations.filter(({ name }) => name !== "search-offerings")
      }
    };
    const result = await resolveSearchCapabilities({
      inspection: withoutSearch,
      collection: { filters: { inline: [filter] } },
      loadPage: vi.fn()
    });
    expect(result.filters.size).toBe(0);
    // Both scopes are reported: a Service-wide block used to be discarded in silence.
    expect(result.issues.map(({ scope }) => scope)).toEqual(["service", "collection"]);
  });

  it("reports a capability source that declares neither inline nor linked definitions", async () => {
    const result = await resolveSearchCapabilities({
      inspection: inspection(undefined),
      collection: { filters: {} as never },
      loadPage: vi.fn()
    });
    expect(result.issues[0]?.message).toContain("Invalid filters capability source");
  });

  it("resolves a sort against the filters its keys name", async () => {
    const result = await resolveSearchCapabilities({
      inspection: inspection({
        filters: { inline: [filter] },
        sorts: {
          inline: [
            {
              id: "region-order",
              title: "Region",
              description: "By region",
              keys: [{ filter_id: "region", direction: "ascending", missing: "last" }]
            }
          ]
        }
      }),
      collection: undefined,
      loadPage: vi.fn()
    });
    expect(result.sorts.get("region-order")?.filters[0]?.id).toBe("region");
    expect(result.issues).toEqual([]);
  });
});
