import { afterEach, describe, expect, it, vi } from "vitest";

import { createInMemoryOdpCache, inspectService, type OdpCache } from "../../src/index.js";

const document = {
  odp_version: "1.0",
  name: "Example",
  description: "An example Service.",
  language: "en",
  localizations: ["en"],
  operations: [
    { authentication: "not-required", name: "list-offerings" },
    { authentication: "optional", name: "get-offering" }
  ],
  http: { endpoint_base: "/odp/" },
  protocols: {
    enrollment: [{ name: "aep" }],
    payments: [
      { authentication: "required", name: "mpp" },
      { authentication: "not-required", name: "x402" }
    ],
    trust: [{ name: "tap" }]
  }
};

function odpResponse(body: BodyInit | null = JSON.stringify(document), init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/odp+json");
  return new Response(body, { ...init, headers });
}

afterEach(() => vi.useRealTimers());

describe("inspectService", () => {
  it("fetches and normalizes the public Service Document", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(odpResponse()));
    const result = await inspectService({
      serviceUrl: "https://example.com/store",
      acceptLanguage: "ja, en;q=0.8",
      fetch
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toEqual(new URL("https://example.com/.well-known/odp"));
    expect(new Headers(init?.headers).get("accept-language")).toBe("ja, en;q=0.8");
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(result).toMatchObject({
      freshness: "fetched",
      capabilities: {
        enrollment: [{ name: "aep" }],
        operations: [
          { authentication: "not-required", name: "list-offerings" },
          { authentication: "optional", name: "get-offering" }
        ],
        payments: [
          { authentication: "required", name: "mpp" },
          { authentication: "not-required", name: "x402" }
        ],
        trust: [{ name: "tap" }]
      }
    });
  });

  it("uses the four-hour fallback and partitions language variants", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const cache = createInMemoryOdpCache();
    const fetch = vi.fn(() => Promise.resolve(odpResponse()));
    await inspectService({ serviceUrl: "https://example.com", acceptLanguage: "en", cache, fetch });
    vi.advanceTimersByTime(3_600_000);
    expect(
      await inspectService({
        serviceUrl: "https://example.com",
        acceptLanguage: "en",
        cache,
        fetch
      })
    ).toMatchObject({ freshness: "fresh" });
    await inspectService({ serviceUrl: "https://example.com", acceptLanguage: "ja", cache, fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("revalidates stale entries with validators", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const cache = createInMemoryOdpCache();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        odpResponse(undefined, { headers: { "cache-control": "max-age=1", etag: '"v1"' } })
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    await inspectService({ serviceUrl: "https://example.com", cache, fetch });
    vi.advanceTimersByTime(2_000);
    const result = await inspectService({ serviceUrl: "https://example.com", cache, fetch });
    const [, init] = fetch.mock.calls[1] ?? [];
    expect(new Headers(init?.headers).get("if-none-match")).toBe('"v1"');
    expect(result.freshness).toBe("revalidated");
  });

  it("does not retain no-store responses", async () => {
    const cache = createInMemoryOdpCache();
    const fetch = vi.fn(() =>
      Promise.resolve(odpResponse(undefined, { headers: { "cache-control": "no-store" } }))
    );
    await inspectService({ serviceUrl: "https://example.com", cache, fetch });
    await inspectService({ serviceUrl: "https://example.com", cache, fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent inspections sharing a cache", async () => {
    const cache = createInMemoryOdpCache();
    const fetch = vi.fn(() => Promise.resolve(odpResponse()));
    await Promise.all([
      inspectService({ serviceUrl: "https://example.com", cache, fetch }),
      inspectService({ serviceUrl: "https://example.com", cache, fetch })
    ]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("follows same-origin redirects and rejects cross-origin redirects", async () => {
    const sameOrigin = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/odp" } }))
      .mockResolvedValueOnce(odpResponse());
    expect(
      (await inspectService({ serviceUrl: "https://example.com", fetch: sameOrigin })).finalUrl.href
    ).toBe("https://example.com/odp");
    const crossOrigin = vi.fn(() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: "https://other.example/odp" } })
      )
    );
    await expect(
      inspectService({ serviceUrl: "https://example.com", fetch: crossOrigin })
    ).rejects.toMatchObject({ code: "invalid_redirect" });
  });

  it.each([
    ["invalid_media_type", () => new Response("{}", { headers: { "content-type": "text/json" } })],
    ["invalid_json", () => odpResponse("{")],
    ["validation_failed", () => odpResponse("{}")],
    ["response_too_large", () => odpResponse("x", { headers: { "content-length": "65537" } })]
  ])("reports %s responses", async (code, response) => {
    await expect(
      inspectService({
        serviceUrl: "https://example.com",
        fetch: vi.fn(() => Promise.resolve(response()))
      })
    ).rejects.toEqual(expect.objectContaining({ code }));
  });

  it("discards an invalid cached representation and fetches it again", async () => {
    const backing = createInMemoryOdpCache();
    const cache: OdpCache = {
      delete: (...arguments_) => backing.delete(...arguments_),
      get: (...arguments_) => backing.get(...arguments_),
      set(record) {
        return backing.set({ ...record, value: {} });
      }
    };
    const fetch = vi.fn(() => Promise.resolve(odpResponse()));
    await inspectService({ serviceUrl: "https://example.com", cache, fetch });
    await inspectService({ serviceUrl: "https://example.com", cache, fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("limits redirects to five", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: "/another" } }))
    );
    await expect(
      inspectService({ serviceUrl: "https://example.com", fetch })
    ).rejects.toMatchObject({ code: "invalid_redirect" });
    expect(fetch).toHaveBeenCalledTimes(6);
  });
});
