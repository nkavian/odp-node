import { describe, expect, it } from "vitest";

import { createInMemoryOdpCache, type OdpCacheRecord } from "../../src/index.js";

const record: OdpCacheRecord = {
  resourceClass: "service-document",
  key: "example",
  url: "https://example.com/.well-known/odp",
  finalUrl: "https://example.com/.well-known/odp",
  value: { name: "Example" },
  policy: { v: 1 } as OdpCacheRecord["policy"]
};

describe("in-memory ODP cache", () => {
  it("isolates stored values from caller mutation", async () => {
    const cache = createInMemoryOdpCache([record]);
    const first = await cache.get("service-document", "example");
    expect(first).toEqual(record);
    if (first !== undefined) first.value = null;
    expect(await cache.get("service-document", "example")).toEqual(record);
  });

  it("partitions records by resource class and opaque key", async () => {
    const cache = createInMemoryOdpCache();
    await cache.set(record);
    expect(await cache.get("offering", "example")).toBeUndefined();
    await cache.delete("service-document", "example");
    expect(await cache.get("service-document", "example")).toBeUndefined();
  });
});
