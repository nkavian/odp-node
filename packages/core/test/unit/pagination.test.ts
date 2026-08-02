import { describe, expect, it, vi } from "vitest";

import { iterateItems, iteratePages, type PageEnvelope } from "../../src/index.js";

async function collect<Value>(values: AsyncIterable<Value>): Promise<Value[]> {
  const result: Value[] = [];
  for await (const value of values) result.push(value);
  return result;
}

describe("pagination", () => {
  it("uses the Service-provided next reference with GET-style loading", async () => {
    const first: PageEnvelope<string> = { odp_version: "1.0", items: ["a"], next: "/pages/2" };
    const load = vi.fn(() => Promise.resolve({ odp_version: "1.0" as const, items: ["b"] }));
    await expect(collect(iterateItems(first, load))).resolves.toEqual(["a", "b"]);
    expect(load).toHaveBeenCalledWith("/pages/2");
  });

  it("detects continuation loops", async () => {
    const first: PageEnvelope<string> = { odp_version: "1.0", items: [], next: "/pages/1" };
    const load = (): Promise<PageEnvelope<string>> => Promise.resolve(first);
    await expect(collect(iteratePages(first, load))).rejects.toThrow("pagination loop");
  });

  it("enforces the 16-page traversal limit", async () => {
    const first: PageEnvelope<string> = { odp_version: "1.0", items: [], next: "/pages/1" };
    let page = 1;
    const load = (): Promise<PageEnvelope<string>> => {
      page += 1;
      return Promise.resolve({ odp_version: "1.0", items: [], next: `/pages/${page}` });
    };
    await expect(collect(iteratePages(first, load))).rejects.toThrow("16-page traversal limit");
  });
});
