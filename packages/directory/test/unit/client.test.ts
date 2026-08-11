import { describe, expect, it, vi } from "vitest";

import { createDirectoryClient } from "../../src/index.js";

const service = {
  service_origin: "https://compute.example",
  name: "Compute",
  description: "GPU compute",
  language: "en",
  localizations: ["en"],
  keywords: ["gpu"],
  operations: [
    { authentication: "not-required", name: "list-offerings" },
    { authentication: "not-required", name: "get-offering" }
  ],
  protocols: {
    payments: [{ authentication: "not-required", name: "mpp", options: ["inflow", "solana"] }]
  },
  indexed_at: "2026-08-02T00:00:00Z"
};

function inputUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("Directory client", () => {
  it("uses the canonical production origin and sends structured filters", async () => {
    let requestUrl = "";
    let body: unknown;
    const transport = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      requestUrl = inputUrl(input);
      body = JSON.parse(typeof init?.body === "string" ? init.body : "null");
      return Promise.resolve(
        response({
          items: [service],
          facets: {
            enrollment: [{ value: { name: "aep" }, count: 1 }],
            keywords: [{ value: "gpu", count: 1 }],
            operations: [
              {
                value: { authentication: "not-required", name: "list-offerings" },
                count: 1
              }
            ],
            payments: [
              {
                value: {
                  authentication: "not-required",
                  name: "mpp",
                  options: ["inflow", "solana"]
                },
                count: 1
              }
            ],
            payment_options: [
              { value: { name: "mpp", option: "inflow" }, count: 1 },
              { value: { name: "mpp", option: "solana" }, count: 1 }
            ]
          }
        })
      );
    });
    const search = createDirectoryClient({ transport }).searchServices({
      query: "compute",
      filters: {
        enrollment: [{ name: "aep" }],
        keywords: ["gpu", "accelerator"],
        operations: [{ authentication: "not-required", name: "list-offerings" }],
        payments: [{ authentication: "not-required", name: "mpp", options: ["inflow", "solana"] }]
      },
      limit: 25
    });
    let facets: unknown;
    for await (const page of search.pages) {
      facets = page.facets;
      break;
    }
    expect(requestUrl).toBe("https://api.inflowpay.ai/v1/services/search");
    expect(body).toEqual({
      query: "compute",
      filters: {
        enrollment: [{ name: "aep" }],
        keywords: ["gpu", "accelerator"],
        operations: [{ authentication: "not-required", name: "list-offerings" }],
        payments: [{ authentication: "not-required", name: "mpp", options: ["inflow", "solana"] }]
      },
      limit: 25
    });
    expect(facets).toEqual({
      enrollment: [{ value: { name: "aep" }, count: 1 }],
      keywords: [{ value: "gpu", count: 1 }],
      operations: [
        {
          value: { authentication: "not-required", name: "list-offerings" },
          count: 1
        }
      ],
      payments: [
        {
          value: {
            authentication: "not-required",
            name: "mpp",
            options: ["inflow", "solana"]
          },
          count: 1
        }
      ],
      payment_options: [
        { value: { name: "mpp", option: "inflow" }, count: 1 },
        { value: { name: "mpp", option: "solana" }, count: 1 }
      ]
    });
  });

  it("uses sandbox only when explicitly selected", async () => {
    let requestUrl = "";
    const transport = vi.fn((input: string | URL | Request) => {
      requestUrl = inputUrl(input);
      return Promise.resolve(response({ items: [] }));
    });
    const client = createDirectoryClient({ environment: "sandbox", transport });
    await client.searchServices().pages[Symbol.asyncIterator]().next();
    expect(client.environment).toBe("sandbox");
    expect(requestUrl).toBe("https://sandbox.inflowpay.ai/v1/services/search");
  });

  it("follows opaque continuation links with GET", async () => {
    const methods: string[] = [];
    const transport = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      const url = new URL(inputUrl(input));
      return Promise.resolve(
        url.searchParams.has("cursor")
          ? response({ items: [{ ...service, service_origin: "https://storage.example" }] })
          : response({ items: [service], next: "/v1/services/search?cursor=opaque" })
      );
    });
    const origins = [];
    for await (const item of createDirectoryClient({ transport }).searchServices().items)
      origins.push(item.service_origin);
    expect(origins).toEqual(["https://compute.example", "https://storage.example"]);
    expect(methods).toEqual(["POST", "GET"]);
  });

  it("resumes an opaque continuation in a later client operation", async () => {
    let method = "";
    const transport = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      method = init?.method ?? "GET";
      return Promise.resolve(response({ items: [service] }));
    });
    const pages = [];
    for await (const page of createDirectoryClient({ transport }).continueSearchServices(
      "/v1/services/search?cursor=opaque",
      { maxPages: 1 }
    ).pages)
      pages.push(page);
    expect(pages).toEqual([{ items: [service] }]);
    expect(method).toBe("GET");
  });

  it("retrieves bounded suggestions from the selected environment", async () => {
    let requestUrl = "";
    const transport = vi.fn((input: string | URL | Request) => {
      requestUrl = inputUrl(input);
      return Promise.resolve(response({ items: ["gpu", "gpu compute"] }));
    });
    const values = await createDirectoryClient({
      environment: "sandbox",
      transport
    }).suggestServices({
      prefix: "gp",
      limit: 5
    });
    expect(values).toEqual(["gpu", "gpu compute"]);
    expect(requestUrl).toBe(
      "https://sandbox.inflowpay.ai/v1/services/suggestions?prefix=gp&limit=5"
    );
  });

  it("accepts an empty suggestion result", async () => {
    const transport = vi.fn(() => Promise.resolve(response({ items: [] })));

    await expect(
      createDirectoryClient({ transport }).suggestServices({ prefix: "unmatched" })
    ).resolves.toEqual([]);
  });

  it("rejects cross-origin continuations and preserves HTTP failure details", async () => {
    const crossOrigin = vi.fn(() =>
      Promise.resolve(response({ items: [], next: "https://other.example/search" }))
    );
    const iterator = createDirectoryClient({ transport: crossOrigin })
      .searchServices()
      .pages[Symbol.asyncIterator]();
    await iterator.next();
    await expect(iterator.next()).rejects.toThrow("canonical origin");

    const unavailable = vi.fn(() => Promise.resolve(response({ message: "Unavailable" }, 503)));
    await expect(
      createDirectoryClient({ transport: unavailable })
        .searchServices()
        .pages[Symbol.asyncIterator]()
        .next()
    ).rejects.toMatchObject({ status: 503 });
  });

  it("stops reading oversized chunked responses", async () => {
    const transport = vi.fn(() =>
      Promise.resolve(
        new Response(new Uint8Array(524_289), {
          headers: { "content-type": "application/json" }
        })
      )
    );
    await expect(
      createDirectoryClient({ transport }).searchServices().pages[Symbol.asyncIterator]().next()
    ).rejects.toThrow("byte limit");
  });
});
