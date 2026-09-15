import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  all: false,
  requestedHost: "example.com",
  records: [{ address: "8.8.8.8", family: 4 }]
}));

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(() => Promise.resolve(state.records))
}));

type LookupCallback = (
  error: Error | null,
  address: string | { address: string; family: number }[],
  family?: number
) => void;

type Lookup = (hostname: string, options: { all?: boolean }, callback: LookupCallback) => void;

vi.mock("undici", () => {
  class Agent {
    readonly lookup: Lookup;

    constructor(options: { connect: { lookup: Lookup } }) {
      this.lookup = options.connect.lookup;
    }

    close(): Promise<void> {
      return Promise.resolve();
    }
  }

  return {
    Agent,
    fetch: vi.fn(
      (_url: URL, options: { dispatcher: Agent }): Promise<Response> =>
        new Promise((resolve, reject) => {
          options.dispatcher.lookup(state.requestedHost, { all: state.all }, (error) => {
            if (error !== null) reject(error);
            else
              resolve(new Response("{}", { headers: { "content-type": "application/odp+json" } }));
          });
        })
    )
  };
});

import { createDefaultTransport } from "../../src/network.js";

beforeEach(() => {
  state.all = false;
  state.requestedHost = "example.com";
  state.records = [{ address: "8.8.8.8", family: 4 }];
});

describe("default ODP transport address pinning", () => {
  it("refuses a connection lookup for a different host", async () => {
    state.requestedHost = "attacker.example";

    await expect(createDefaultTransport()(new URL("https://example.com/"))).rejects.toThrow(
      "unvalidated host"
    );
  });

  it("returns the pinned address for a single-address lookup", async () => {
    const response = await createDefaultTransport()(new URL("https://example.com/"));

    expect(response.status).toBe(200);
  });

  it("requires a local development host to resolve only to loopback addresses", async () => {
    state.requestedHost = "localhost";

    await expect(createDefaultTransport(true)(new URL("http://localhost/"))).rejects.toThrow(
      "outside the loopback network"
    );
  });
});
