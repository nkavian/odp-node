import { describe, expect, it } from "vitest";

import {
  OdpValidationError,
  parseOffering,
  parseFilterDefinition,
  parseSortDefinition,
  parseProblemResponse,
  parseServiceDocument,
  safeParseOffering,
  safeParseCollection,
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
        icon: { src: "/branding/icon.svg", type: "image/svg+xml" },
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
});
