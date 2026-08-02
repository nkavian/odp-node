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
  operations: { supported: ["list-offerings", "get-offering", "search-offerings"] },
  http: { endpoint_base: "/odp" }
};

function directoryService(origin: string, name: string) {
  return {
    service_origin: origin,
    name,
    description: `${name} catalog`,
    language: "en",
    localizations: ["en"],
    operations: ["list-offerings", "get-offering", "search-offerings"],
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
      new URL("https://sandbox.offeringprotocol.org/v1/services/search"),
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
});
