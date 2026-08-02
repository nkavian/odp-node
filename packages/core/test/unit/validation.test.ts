import { describe, expect, it } from "vitest";

import {
  OdpValidationError,
  parseOffering,
  parseFilterDefinition,
  parseSortDefinition,
  parseProblemResponse,
  parseServiceDocument,
  safeParseOffering,
  safeParseServiceDocument
} from "../../src/index.js";

const serviceDocument = {
  odp_version: "1.0",
  name: "Example",
  description: "An example Service.",
  language: "en",
  localizations: ["en"],
  operations: { supported: ["list-offerings", "get-offering"] },
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
