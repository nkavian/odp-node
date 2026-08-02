import { describe, expect, it } from "vitest";

import {
  buildOdpOperationUrl,
  buildOperationUrl,
  resolveContinuation,
  resolveResourceReference
} from "../../src/index.js";

describe("resource references", () => {
  it("resolves origin-relative and secure absolute references", () => {
    expect(resolveResourceReference("/odp/offerings/123", "https://market.example").href).toBe(
      "https://market.example/odp/offerings/123"
    );
    expect(
      resolveResourceReference("https://catalog.example/offerings/123", "https://market.example")
        .href
    ).toBe("https://catalog.example/offerings/123");
  });

  it("rejects public HTTP and fragments", () => {
    expect(() =>
      resolveResourceReference("http://catalog.example/offerings/123", "https://market.example")
    ).toThrow(TypeError);
    expect(() =>
      resolveResourceReference("/odp/offerings/123#details", "https://market.example")
    ).toThrow(TypeError);
  });

  it("requires continuation links to remain on the Service origin", () => {
    expect(resolveContinuation("/odp/pages/abc", "https://market.example").href).toBe(
      "https://market.example/odp/pages/abc"
    );
    expect(() =>
      resolveContinuation("https://other.example/pages/abc", "https://market.example")
    ).toThrow(TypeError);
  });

  it("constructs fixed operation paths over the advertised endpoint base", () => {
    expect(buildOperationUrl("/odp/", "/offerings/123", "https://market.example").href).toBe(
      "https://market.example/odp/offerings/123"
    );
    expect(
      buildOdpOperationUrl("/odp/", "get-offering", "https://market.example", "123").href
    ).toBe("https://market.example/odp/offerings/123");
    expect(() => buildOdpOperationUrl("/odp/", "get-offering", "https://market.example")).toThrow(
      TypeError
    );
  });
});
