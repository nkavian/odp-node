import { describe, expect, it, vi } from "vitest";

import {
  createOdpAgent,
  createOdpServiceClient,
  type FederatedDiscoveryEvent
} from "../../src/index.js";

const serviceDocument = {
  odp_version: "1.0",
  name: "Example",
  description: "Example catalog",
  language: "en",
  localizations: ["en"],
  operations: [
    { authentication: "not-required", name: "list-offerings" },
    { authentication: "not-required", name: "get-offering" },
    { authentication: "not-required", name: "search-offerings" }
  ],
  http: { endpoint_base: "/odp" }
};

function directoryService(origin: string, name: string) {
  return {
    service_origin: origin,
    name,
    description: `${name} catalog`,
    language: "en",
    localizations: ["en"],
    operations: [
      { authentication: "not-required", name: "list-offerings" },
      { authentication: "not-required", name: "get-offering" },
      { authentication: "not-required", name: "search-offerings" }
    ],
    indexed_at: "2026-08-02T00:00:00Z"
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/odp+json" }
  });
}

function directoryJson(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" }
  });
}

describe("ODP agent", () => {
  it("searches bounded Services concurrently and emits results in directory order", async () => {
    const services = [
      directoryService("https://slow.example", "Slow"),
      directoryService("https://fast.example", "Fast"),
      directoryService("https://later.example", "Later")
    ];
    let releaseSlow: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let fastCompleted = false;
    let active = 0;
    let maximumActive = 0;

    const directoryTransport = vi.fn(() => Promise.resolve(directoryJson({ items: services })));
    const agent = createOdpAgent({
      environment: "sandbox",
      directoryTransport,
      serviceClient(service) {
        return createOdpServiceClient({
          serviceUrl: service.service_origin,
          transport: vi.fn(async (input) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname === "/.well-known/odp") return json(serviceDocument);
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            if (service.name === "Slow") await slow;
            if (service.name === "Fast") fastCompleted = true;
            active -= 1;
            return json({
              odp_version: "1.0",
              items: [{ id: service.name.toLowerCase(), name: service.name }]
            });
          }),
          cachePartition: "test"
        });
      }
    });

    const collect = async (): Promise<FederatedDiscoveryEvent[]> => {
      const events: FederatedDiscoveryEvent[] = [];
      for await (const event of agent.searchOfferingsAcrossServices({
        services: { query: "compute" },
        offerings: { query: "gpu" },
        concurrency: 2,
        maxServices: 3,
        maxOfferingsPerService: 1
      }))
        events.push(event);
      return events;
    };
    const result = collect();
    await vi.waitFor(() => expect(fastCompleted).toBe(true));
    releaseSlow?.();
    const events = await result;

    expect(agent.environment).toBe("sandbox");
    expect(maximumActive).toBe(2);
    expect(events.map((event) => event?.service.name)).toEqual(["Slow", "Fast", "Later"]);
    expect(directoryTransport).toHaveBeenCalledWith(
      new URL("https://sandbox.inflowpay.ai/v1/services/search"),
      expect.objectContaining({ method: "POST" })
    );
  });

  it("reports one Service failure without discarding successful results", async () => {
    const services = [
      directoryService("https://bad.example", "Bad"),
      directoryService("https://good.example", "Good")
    ];
    const agent = createOdpAgent({
      directoryTransport: vi.fn(() => Promise.resolve(directoryJson({ items: services }))),
      serviceClient(service) {
        return createOdpServiceClient({
          serviceUrl: service.service_origin,
          transport: vi.fn((input) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname === "/.well-known/odp") return Promise.resolve(json(serviceDocument));
            if (service.name === "Bad") return Promise.resolve(json({ title: "Unavailable" }, 503));
            return Promise.resolve(
              json({ odp_version: "1.0", items: [{ id: "good", name: "Good" }] })
            );
          }),
          cachePartition: "test"
        });
      }
    });

    const events = [];
    for await (const event of agent.searchOfferingsAcrossServices()) events.push(event);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "issue", service: { name: "Bad" } });
    expect(events[1]).toMatchObject({
      type: "offering",
      service: { name: "Good" },
      offering: { id: "good" }
    });
  });

  it("rejects invalid orchestration bounds before making a request", async () => {
    const directoryTransport = vi.fn(() => Promise.resolve(directoryJson({ items: [] })));
    const iterator = createOdpAgent({ directoryTransport })
      .searchOfferingsAcrossServices({ concurrency: 17 })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(
      "concurrency must be an integer from 1 through 16"
    );
    expect(directoryTransport).not.toHaveBeenCalled();
  });
  it("does not leave a rejected Service search unhandled when the consumer stops early", async () => {
    const services = [
      directoryService("https://one.example", "One"),
      directoryService("https://two.example", "Two"),
      directoryService("https://three.example", "Three")
    ];
    const unhandled: unknown[] = [];
    const capture = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", capture);
    try {
      const agent = createOdpAgent({
        directoryTransport: vi.fn(() => Promise.resolve(directoryJson({ items: services }))),
        serviceClient(service) {
          return createOdpServiceClient({
            serviceUrl: service.service_origin,
            transport: vi.fn(async (input) => {
              const url = new URL(input instanceof Request ? input.url : String(input));
              if (url.pathname === "/.well-known/odp") return json(serviceDocument);
              if (service.name !== "One") {
                // Long enough that this search is still in flight when the consumer breaks.
                await new Promise((resolve) => setTimeout(resolve, 10));
                throw new Error("service exploded");
              }
              return json({ odp_version: "1.0", items: [{ id: "one", name: "One" }] });
            }),
            cachePartition: "test"
          });
        }
      });

      for await (const event of agent.searchOfferingsAcrossServices({ concurrency: 3 })) {
        expect(event.type).toBe("offering");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Every scheduled search used to be an unattended promise; one rejecting after the consumer
      // stopped brought the process down under Node's default rejection handling.
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", capture);
    }
  });

  it("stops in-flight Service searches once the consumer stops iterating", async () => {
    const services = [
      directoryService("https://one.example", "One"),
      directoryService("https://two.example", "Two")
    ];
    const signals: AbortSignal[] = [];
    const agent = createOdpAgent({
      directoryTransport: vi.fn(() => Promise.resolve(directoryJson({ items: services }))),
      serviceClient(service) {
        return createOdpServiceClient({
          serviceUrl: service.service_origin,
          transport: vi.fn(async (input: URL, init?: RequestInit) => {
            const url = new URL(String(input));
            if (url.pathname === "/.well-known/odp") return json(serviceDocument);
            const signal = init?.signal;
            if (signal instanceof AbortSignal) signals.push(signal);
            if (service.name === "Two") await new Promise((resolve) => setTimeout(resolve, 20));
            return json({
              odp_version: "1.0",
              items: [{ id: service.name.toLowerCase(), name: service.name }]
            });
          }),
          cachePartition: "test"
        });
      }
    });

    for await (const event of agent.searchOfferingsAcrossServices({ concurrency: 2 })) {
      void event;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("holds concurrency at the bound even when a task is submitted mid-release", async () => {
    // `createScheduler` is not exported, so exercise it through the public path with a bound of 1.
    const services = Array.from({ length: 4 }, (_value, index) =>
      directoryService(`https://s${String(index)}.example`, `S${String(index)}`)
    );
    let active = 0;
    let maximumActive = 0;
    const agent = createOdpAgent({
      directoryTransport: vi.fn(() => Promise.resolve(directoryJson({ items: services }))),
      serviceClient(service) {
        return createOdpServiceClient({
          serviceUrl: service.service_origin,
          transport: vi.fn(async (input) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname === "/.well-known/odp") return json(serviceDocument);
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active -= 1;
            return json({ odp_version: "1.0", items: [{ id: "x", name: service.name }] });
          }),
          cachePartition: "test"
        });
      }
    });
    const events = [];
    for await (const event of agent.searchOfferingsAcrossServices({ concurrency: 1 }))
      events.push(event);
    expect(events).toHaveLength(4);
    expect(maximumActive).toBe(1);
  });

  it("surfaces an abort as an abort rather than a per-Service issue", async () => {
    const controller = new AbortController();
    const agent = createOdpAgent({
      directoryTransport: vi.fn(() =>
        Promise.resolve(directoryJson({ items: [directoryService("https://one.example", "One")] }))
      ),
      serviceClient(service) {
        return createOdpServiceClient({
          serviceUrl: service.service_origin,
          transport: vi.fn(async (input: URL, init?: RequestInit) => {
            const url = new URL(String(input));
            if (url.pathname === "/.well-known/odp") return json(serviceDocument);
            controller.abort();
            await new Promise((resolve) => setTimeout(resolve, 1));
            init?.signal?.throwIfAborted();
            return json({ odp_version: "1.0", items: [] });
          }),
          cachePartition: "test"
        });
      }
    });
    await expect(
      (async () => {
        await drain(agent.searchOfferingsAcrossServices({ signal: controller.signal }));
      })()
    ).rejects.toThrow();
  });

  it("uses list-collection-offerings when only a Collection is named", async () => {
    const paths: string[] = [];
    const agent = createOdpAgent({
      directoryTransport: vi.fn(() =>
        Promise.resolve(directoryJson({ items: [directoryService("https://one.example", "One")] }))
      ),
      serviceClient(service) {
        return createOdpServiceClient({
          serviceUrl: service.service_origin,
          transport: vi.fn((input) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname === "/.well-known/odp")
              return Promise.resolve(
                json({
                  ...serviceDocument,
                  operations: [
                    ...serviceDocument.operations,
                    { authentication: "not-required", name: "list-collection-offerings" }
                  ]
                })
              );
            paths.push(url.pathname);
            return Promise.resolve({ odp_version: "1.0", items: [] }).then((value) => json(value));
          }),
          cachePartition: "test"
        });
      }
    });
    await drain(agent.searchOfferingsAcrossServices({ offerings: { collection_id: "compute" } }));
    expect(paths).toEqual(["/odp/collections/compute/offerings"]);
  });
});

/** Consumes an async iterable for its side effects, without binding an unused loop variable. */
async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const item of iterable) void item;
}
