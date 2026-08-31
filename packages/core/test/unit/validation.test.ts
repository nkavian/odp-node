import { describe, expect, it } from "vitest";

import {
  OdpValidationError,
  normalizeAgentResponse,
  parseAgentServiceDocument,
  parseCollection,
  parseFilterDefinition,
  parseOffering,
  parseSortDefinition,
  parseProblemResponse,
  parseServiceDocument,
  safeParseOffering,
  safeParseCollection,
  safeParseAgentServiceDocument,
  safeParseFilterDefinition,
  safeParseServiceDocument
} from "../../src/index.js";

const serviceDocument = {
  odp_version: "1.0",
  name: "Example",
  description: "An example Service.",
  language: "en",
  localizations: ["en"],
  operations: [
    { authentication: "not-required", name: "list-offerings" },
    { authentication: "not-required", name: "get-offering" }
  ],
  http: { endpoint_base: "/odp/" }
};

describe("Service Document validation", () => {
  it("parses the minimum Service integration", () => {
    expect(parseServiceDocument(serviceDocument)).toEqual(serviceDocument);
  });

  it("reports all schema issues without throwing", () => {
    const result = safeParseServiceDocument({
      ...serviceDocument,
      name: "",
      keywords: [" compute"]
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("requires the default language in localizations", () => {
    const result = safeParseServiceDocument({ ...serviceDocument, language: "ja" });
    expect(result).toMatchObject({
      success: false,
      issues: [{ keyword: "contains-default-language", path: "/localizations" }]
    });
  });

  it("parses optional branding and a service-wide OpenAPI document", () => {
    const document = {
      ...serviceDocument,
      branding: {
        icon: { src: "/branding/icon.svg" },
        logo: { src: "/branding/logo.webp", type: "image/webp" }
      },
      http: {
        endpoint_base: "/odp/",
        openapi: { url: "/openapi.json" }
      }
    };

    expect(parseServiceDocument(document)).toEqual(document);
  });

  it("parses optional Service resource links", () => {
    const document = {
      ...serviceDocument,
      documentation_url: "/developers/",
      status_url: "https://status.example.com/",
      support_url: "/support/",
      website_url: "/store/"
    };

    expect(parseServiceDocument(document)).toEqual(document);
    expect(
      safeParseServiceDocument({ ...document, support_url: "//support.example.com/" }).success
    ).toBe(false);
    expect(safeParseServiceDocument({ ...document, web_url: "/store/" }).success).toBe(false);
  });

  it("parses optional MCP endpoints", () => {
    const document = {
      ...serviceDocument,
      mcp: [
        {
          description: "Browse the public catalog.",
          name: "Catalog",
          type: "streamable-http",
          url: "/mcp"
        }
      ]
    };

    expect(parseServiceDocument(document)).toEqual(document);
    expect(
      safeParseServiceDocument({
        ...document,
        mcp: [{ type: "sse", url: "/mcp" }]
      }).success
    ).toBe(false);
  });

  it("parses payment origins", () => {
    const document = {
      ...serviceDocument,
      payment_origins: ["https://payments.example.com"]
    };

    expect(parseServiceDocument(document)).toEqual(document);
    expect(
      safeParseServiceDocument({
        ...document,
        payment_origins: ["https://payments.example.com", "https://payments.example.com"]
      }).success
    ).toBe(true);
  });

  it("requires complete branding metadata", () => {
    expect(
      safeParseServiceDocument({
        ...serviceDocument,
        branding: { icon: { src: "/branding/icon.png", type: "image/png" } }
      }).success
    ).toBe(false);
  });

  it("validates advertised payment options", () => {
    const document = {
      ...serviceDocument,
      protocols: {
        payments: [
          {
            authentication: "not-required",
            name: "mpp",
            options: ["card", "inflow", "solana"]
          }
        ]
      }
    };

    expect(parseServiceDocument(document)).toEqual(document);
    expect(
      safeParseServiceDocument({
        ...document,
        protocols: {
          payments: [{ ...document.protocols.payments[0], options: ["future-option"] }]
        }
      }).success
    ).toBe(false);
    expect(
      safeParseServiceDocument({
        ...document,
        protocols: {
          payments: [{ ...document.protocols.payments[0], options: ["solana", "solana"] }]
        }
      }).success
    ).toBe(false);
  });

  it("keeps Service validation strict and filters unknown protocols for Agents", () => {
    const document = {
      ...serviceDocument,
      protocols: {
        enrollment: [{ name: "future-enrollment" }, { name: "aep" }],
        payments: [
          { authentication: "not-required", name: "future-payment" },
          { authentication: "not-required", name: "mpp" },
          { authentication: "not-required", name: "x402" }
        ],
        trust: [{ name: "future-trust" }, { name: "tap" }]
      }
    };

    expect(safeParseServiceDocument(document).success).toBe(false);
    expect(parseAgentServiceDocument(document).protocols).toEqual({
      enrollment: [{ name: "aep" }],
      payments: [
        { authentication: "not-required", name: "mpp" },
        { authentication: "not-required", name: "x402" }
      ],
      trust: [{ name: "tap" }]
    });
  });

  it("omits Agent protocol categories containing only unknown names", () => {
    expect(
      parseAgentServiceDocument({
        ...serviceDocument,
        protocols: {
          enrollment: [{ name: "future-enrollment" }],
          payments: [{ authentication: "not-required", name: "future-payment" }],
          trust: [{ name: "future-trust" }]
        }
      }).protocols
    ).toBeUndefined();
  });

  it("does not filter malformed descriptors with recognized protocol names", () => {
    expect(
      safeParseAgentServiceDocument({
        ...serviceDocument,
        protocols: { payments: [{ name: "mpp" }] }
      }).success
    ).toBe(false);
  });
});

describe("Agent response compatibility", () => {
  it("isolates unknown Service capabilities", () => {
    expect(
      normalizeAgentResponse(
        {
          operations: [
            { authentication: "not-required", name: "list-offerings" },
            { authentication: "not-required", name: "future-operation" },
            { authentication: "not-required", name: "get-offering", future: true }
          ],
          mcp: [
            { type: "streamable-http", url: "/mcp" },
            { type: "future", url: "/future" },
            { type: "streamable-http", url: "/future-member", future: true }
          ],
          branding: {
            icon: { src: "/icon", type: "image/future" },
            logo: { src: "/logo", type: "image/png", future: true },
            future: {}
          },
          protocols: {
            payments: [
              {
                authentication: "not-required",
                name: "mpp",
                options: ["inflow", "future"]
              }
            ]
          },
          search_capabilities: {
            filters: {
              inline: [
                { type: "string", operators: ["eq"] },
                { type: "future", operators: ["eq"] }
              ]
            },
            sorts: {
              inline: [
                { keys: [{ direction: "ascending", missing: "last" }] },
                { keys: [{ direction: "future", missing: "last" }] }
              ]
            }
          }
        },
        "service-document"
      )
    ).toEqual({
      operations: [{ authentication: "not-required", name: "list-offerings" }],
      mcp: [{ type: "streamable-http", url: "/mcp" }],
      branding: { logo: { src: "/logo", type: "image/png" } },
      protocols: {
        payments: [{ authentication: "not-required", name: "mpp", options: ["inflow"] }]
      },
      search_capabilities: {
        filters: { inline: [{ type: "string", operators: ["eq"] }] },
        sorts: { inline: [{ keys: [{ direction: "ascending", missing: "last" }] }] }
      }
    });
  });

  it("isolates unknown Offering capabilities", () => {
    expect(
      normalizeAgentResponse(
        {
          images: [
            { src: "/image", type: "image/png", future: true },
            { src: "/future", type: "image/future" }
          ],
          schema: { url: "/schema", future: true },
          price: { type: "future" },
          actions: [
            {
              authentication: "not-required",
              http: { href: "/run", method: "POST" },
              id: "run",
              rel: "future"
            },
            {
              authentication: "not-required",
              http: { href: "/future", method: "PATCH" },
              id: "future",
              rel: "invoke"
            },
            {
              authentication: "not-required",
              http: { href: "/future-member", method: "POST", future: true },
              id: "future-member",
              rel: "invoke"
            }
          ]
        },
        "offering"
      )
    ).toEqual({
      images: [{ src: "/image", type: "image/png" }],
      actions: [
        {
          authentication: "not-required",
          http: { href: "/run", method: "POST" },
          id: "run",
          rel: "future"
        }
      ]
    });
  });

  it("normalizes pages and problems at the affected item boundary", () => {
    expect(
      normalizeAgentResponse(
        { items: [{ images: [{ src: "/future", type: "image/future" }] }] },
        "collection-page"
      )
    ).toEqual({ items: [{}] });
    expect(
      normalizeAgentResponse(
        {
          items: [
            { type: "string", operators: ["eq"] },
            { type: "string", operators: ["future"] }
          ]
        },
        "filter-page"
      )
    ).toEqual({ items: [{ type: "string", operators: ["eq"] }] });
    expect(
      normalizeAgentResponse(
        {
          invalid_params: [
            { in: "query", name: "limit", reason: "invalid" },
            { in: "future", name: "future", reason: "invalid" }
          ]
        },
        "problem"
      )
    ).toEqual({ invalid_params: [{ in: "query", name: "limit", reason: "invalid" }] });
  });
});

describe("search capability validation", () => {
  it("parses Filter and Sort Definitions", () => {
    expect(
      parseFilterDefinition({
        id: "region",
        title: "Region",
        description: "Deployment region",
        type: "string",
        operators: ["eq"]
      }).id
    ).toBe("region");
    expect(
      parseSortDefinition({
        id: "region-order",
        title: "Region order",
        description: "Orders by region",
        keys: [{ filter_id: "region", direction: "ascending", missing: "last" }]
      }).id
    ).toBe("region-order");
  });

  it("rejects operators and units that are incompatible with the Filter type", () => {
    expect(
      safeParseFilterDefinition({
        id: "material",
        title: "Material",
        description: "Primary material",
        type: "string",
        operators: ["gte"]
      }).success
    ).toBe(false);
    expect(
      safeParseFilterDefinition({
        id: "available",
        title: "Available",
        description: "Current availability",
        type: "boolean",
        operators: ["eq"],
        unit: { system: "ucum", code: "1" }
      }).success
    ).toBe(false);
  });
});

describe("Collection validation", () => {
  it("parses optional Collection images", () => {
    const collection = {
      odp_version: "1.0",
      id: "gpus",
      name: "GPUs",
      images: [{ src: "/images/gpus.jpg" }]
    };
    expect(parseCollection(collection)).toEqual(collection);
  });

  it("rejects duplicate Collection image sources", () => {
    expect(
      safeParseCollection({
        odp_version: "1.0",
        id: "gpus",
        name: "GPUs",
        images: [{ src: "/images/gpus.jpg" }, { src: "/images/gpus.jpg" }]
      }).success
    ).toBe(false);
  });

  it("validates localization relationships without case-sensitive duplicates", () => {
    expect(
      safeParseCollection({
        odp_version: "1.0",
        id: "gpus",
        name: "GPUs",
        language: "ja",
        localizations: ["en"]
      }).success
    ).toBe(false);
    expect(
      safeParseCollection({
        odp_version: "1.0",
        id: "gpus",
        name: "GPUs",
        language: "en",
        localizations: ["en", "EN"]
      }).success
    ).toBe(false);
  });

  it("rejects malformed language tags", () => {
    expect(
      safeParseCollection({
        odp_version: "1.0",
        id: "gpus",
        name: "GPUs",
        language: "en-a",
        localizations: ["en-a"]
      }).success
    ).toBe(false);
  });
});

describe("Offering validation", () => {
  it("parses a minimal full Offering", () => {
    const offering = { odp_version: "1.0", id: "handbook", name: "Agent handbook" };
    expect(parseOffering(offering)).toEqual(offering);
  });

  it("parses optional Offering images", () => {
    const offering = {
      odp_version: "1.0",
      id: "handbook",
      name: "Agent handbook",
      images: [
        {
          alt: "Agent handbook cover",
          height: 1200,
          src: "/images/handbook.webp",
          type: "image/webp",
          width: 900
        }
      ]
    };
    expect(parseOffering(offering)).toEqual(offering);
  });

  it("rejects duplicate Offering image sources", () => {
    expect(
      safeParseOffering({
        odp_version: "1.0",
        id: "handbook",
        name: "Agent handbook",
        images: [{ src: "/images/handbook.webp" }, { src: "/images/handbook.webp" }]
      }).success
    ).toBe(false);
  });

  it("requires a schema when attributes are present", () => {
    const result = safeParseOffering({
      odp_version: "1.0",
      id: "gpu",
      name: "GPU rental",
      attributes: { model: "A100" }
    });
    expect(result.success).toBe(false);
  });

  it("rejects repeated language variants", () => {
    expect(
      safeParseOffering({
        odp_version: "1.0",
        id: "gpu",
        name: "GPU rental",
        language: "sl-rozaj-rozaj",
        localizations: ["sl-rozaj-rozaj"]
      }).success
    ).toBe(false);
  });

  it("throws a structured validation error", () => {
    expect(() => parseOffering({ odp_version: "1.0", id: "..", name: "Invalid" })).toThrow(
      OdpValidationError
    );
  });
});

describe("Problem Details validation", () => {
  const problem = {
    type: "https://offeringprotocol.org/problems/invalid-request",
    title: "Invalid request",
    status: 400,
    code: "INVALID_REQUEST"
  };

  it("checks the HTTP response status", () => {
    expect(parseProblemResponse(problem, 400)).toEqual(problem);
    expect(() => parseProblemResponse(problem, 422)).toThrow(OdpValidationError);
  });

  it("requires title and matching problem type", () => {
    expect(() => parseProblemResponse({ ...problem, title: undefined }, 400)).toThrow(
      OdpValidationError
    );
    expect(() =>
      parseProblemResponse(
        { ...problem, type: "https://offeringprotocol.org/problems/not-found" },
        400
      )
    ).toThrow(OdpValidationError);
  });
});
