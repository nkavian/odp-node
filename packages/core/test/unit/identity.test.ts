import { describe, expect, it } from "vitest";

import {
  createResourceIdentity,
  deriveServiceOrigin,
  isLocalResourceIdentifier,
  resourceIdentitiesEqual,
  resourceIdentityKey
} from "../../src/index.js";

describe("resource identity", () => {
  it.each([
    ["4821", true],
    ["catalog.Offering~4821", true],
    [".", false],
    ["..", false],
    ["商品-東京-42", false],
    ["", false]
  ])("validates local identifier %j", (value, expected) => {
    expect(isLocalResourceIdentifier(value)).toBe(expected);
  });

  it("derives the canonical origin from the final Service Document URL", () => {
    expect(deriveServiceOrigin("https://market.example/.well-known/odp")).toBe(
      "https://market.example"
    );
  });

  it("composes and compares the structured identity tuple", () => {
    const identity = createResourceIdentity(
      "https://market.example/.well-known/odp",
      "offering",
      "123"
    );
    expect(resourceIdentityKey(identity)).toBe("https://market.example\u0000offering\u0000123");
    expect(resourceIdentitiesEqual(identity, { ...identity })).toBe(true);
    expect(resourceIdentitiesEqual(identity, { ...identity, type: "collection" })).toBe(false);
  });
});
