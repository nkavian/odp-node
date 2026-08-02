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
      operations: ["list-offerings", "get-offering", "search-offerings"],
      onboarding: [],
      payments: []
    },
    document: {
      odp_version: "1.0",
      name: "Example",
      description: "Example",
      language: "en",
      localizations: ["en"],
      operations: { supported: ["list-offerings", "get-offering", "search-offerings"] },
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
});
