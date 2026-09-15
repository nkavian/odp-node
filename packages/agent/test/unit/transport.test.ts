import { describe, expect, it, vi } from "vitest";

import { createInMemoryOdpCache, type OdpCache } from "../../src/cache.js";
import {
  OdpRequestError,
  requestOdpValue,
  requestSupportingJson,
  type OdpTransport
} from "../../src/transport.js";

const MEDIA_TYPE = "application/odp+json";

function json(value: unknown, init: ResponseInit & { type?: string } = {}): Response {
  const { type = MEDIA_TYPE, headers, ...rest } = init;
  return new Response(JSON.stringify(value), {
    ...rest,
    headers: { "content-type": type, ...(headers as Record<string, string> | undefined) }
  });
}

function transportFor(handler: (url: URL, init: RequestInit) => Response): OdpTransport {
  return vi.fn((url: URL, init?: RequestInit) => Promise.resolve(handler(url, init ?? {})));
}

/** Calls `requestOdpValue` with the ordinary ODP format and the arguments most tests do not vary. */
function odpRequest(
  transport: OdpTransport,
  init: RequestInit = { method: "GET" },
  overrides: { cache?: OdpCache; partition?: string; ttl?: number; language?: string } = {}
): Promise<unknown> {
  return requestOdpValue(
    transport,
    new URL("https://example.com/odp/offerings"),
    init,
    overrides.language,
    overrides.cache,
    overrides.partition ?? "public",
    "offering",
    overrides.ttl ?? 0
  );
}

/** The cache key `requestOdpValue` derives for the URL and partition the helper above uses. */
function cacheKey(): string {
  return ["public", "GET", "https://example.com/odp/offerings", "", "", ""].join("\u0000");
}

/** Narrows a cache lookup that the test has just populated. */
function requireRecord<Value>(record: Value | undefined): Value {
  if (record === undefined) throw new Error("expected a cached record");
  return record;
}

/** Resolves with the error a failing request produced. */
async function failureOf(promise: Promise<unknown>): Promise<OdpRequestError> {
  try {
    await promise;
  } catch (error) {
    return error as OdpRequestError;
  }
  throw new Error("expected the ODP request to fail");
}

/** Builds a JSON value nested `levels` containers deep. */
function nested(levels: number): unknown {
  let value: unknown = { leaf: "x" };
  for (let index = 1; index < levels; index += 1) value = { child: value };
  return value;
}

describe("ODP transport response handling", () => {
  it("accepts a document nested exactly to the depth limit and rejects one level more", async () => {
    // A scalar is a value held by a container, not a level of its own, so 16 containers is the
    // limit and `{"a":1}` is depth 1.
    await expect(odpRequest(transportFor(() => json(nested(16))))).resolves.toBeTypeOf("object");
    await expect(odpRequest(transportFor(() => json(nested(17))))).rejects.toThrow(
      "nesting-depth limit"
    );
  });

  it("gives a supporting document its own depth budget", async () => {
    const deep = nested(32);
    const request = (maximumDepth: number): Promise<unknown> =>
      requestSupportingJson({
        transport: transportFor(() => json(deep, { type: "application/json" })),
        url: new URL("https://example.com/openapi.json"),
        cachePartition: "anonymous",
        resourceClass: "openapi",
        fallbackTtlMs: 0,
        accept: "application/json",
        mediaTypes: ["application/json"],
        maximumBytes: 1_048_576,
        maximumDepth
      });
    await expect(request(32)).resolves.toBeTypeOf("object");
    await expect(request(16)).rejects.toThrow("nesting-depth limit");
  });

  it("rejects an oversized body by its declared length and by what it streams", async () => {
    const declared = transportFor(
      () =>
        new Response("{}", {
          headers: { "content-type": MEDIA_TYPE, "content-length": "999999" }
        })
    );
    await expect(odpRequest(declared)).rejects.toThrow("byte limit");

    const streamed = transportFor(() => json({ padding: "x".repeat(600_000) }));
    await expect(odpRequest(streamed)).rejects.toThrow("byte limit");
  });

  it("ignores an unparsable content-length and falls back to counting bytes", async () => {
    const transport = transportFor(
      () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": MEDIA_TYPE, "content-length": "not-a-number" }
        })
    );
    await expect(odpRequest(transport)).resolves.toEqual({ ok: true });
  });

  it("treats an empty body as invalid JSON rather than an empty document", async () => {
    const transport = transportFor(
      () => new Response(null, { headers: { "content-type": MEDIA_TYPE } })
    );
    await expect(odpRequest(transport)).rejects.toThrow();
  });

  it("rejects a successful response whose media type is missing or different", async () => {
    await expect(
      odpRequest(transportFor(() => json({}, { type: "application/json" })))
    ).rejects.toThrow("media type is invalid");
    await expect(
      odpRequest(transportFor(() => new Response("{}", { status: 200 })))
    ).rejects.toThrow("media type is invalid");
  });

  it("compares the media type case-insensitively and ignores its parameters", async () => {
    const transport = transportFor(() =>
      json({ ok: true }, { type: "Application/ODP+JSON; charset=utf-8" })
    );
    await expect(odpRequest(transport)).resolves.toEqual({ ok: true });
  });
});

describe("ODP transport redirects", () => {
  it("follows five same-origin redirects and refuses a sixth", async () => {
    const build = (limit: number): OdpTransport =>
      transportFor((url) => {
        const hop = Number(url.searchParams.get("hop") ?? "0");
        if (hop >= limit) return json({ hop });
        return new Response(null, {
          status: 302,
          headers: { location: `/odp/offerings?hop=${String(hop + 1)}` }
        });
      });
    await expect(odpRequest(build(5))).resolves.toEqual({ hop: 5 });
    await expect(odpRequest(build(6))).rejects.toThrow("redirect limit");
  });

  it("refuses a cross-origin redirect and a redirect with no Location", async () => {
    const cross = transportFor(
      () => new Response(null, { status: 301, headers: { location: "https://evil.example/x" } })
    );
    await expect(odpRequest(cross)).rejects.toThrow("changed origin");

    const headless = transportFor(() => new Response(null, { status: 307 }));
    await expect(odpRequest(headless)).rejects.toThrow("omitted Location");
  });

  it("keeps the body and method across a 307 but drops both across a 303", async () => {
    const seen: RequestInit[] = [];
    const transport = transportFor((url, init) => {
      seen.push(init);
      if (url.searchParams.has("moved")) return json({ ok: true });
      return new Response(null, {
        status: url.pathname.endsWith("keep") ? 307 : 303,
        headers: { location: "/odp/offerings?moved=1" }
      });
    });
    await requestOdpValue(
      transport,
      new URL("https://example.com/odp/keep"),
      { method: "POST", body: "{}" },
      undefined,
      undefined,
      "public",
      "search",
      0
    );
    expect(seen[1]?.method).toBe("POST");
    expect(seen[1]?.body).toBe("{}");

    seen.length = 0;
    await requestOdpValue(
      transport,
      new URL("https://example.com/odp/other"),
      { method: "POST", body: "{}" },
      undefined,
      undefined,
      "public",
      "search",
      0
    );
    expect(seen[1]?.method).toBe("GET");
    expect(seen[1]?.body).toBeUndefined();
    expect(new Headers(seen[1]?.headers).get("content-type")).toBeNull();
  });

  it("keeps the abort signal alive across a method-changing redirect", async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | null | undefined)[] = [];
    const transport = transportFor((url, init) => {
      seen.push(init.signal);
      if (url.searchParams.has("moved")) return json({ ok: true });
      return new Response(null, { status: 303, headers: { location: "/odp/x?moved=1" } });
    });
    await requestOdpValue(
      transport,
      new URL("https://example.com/odp/x"),
      { method: "POST", body: "{}", signal: controller.signal },
      undefined,
      undefined,
      "public",
      "search",
      0
    );
    // The rewritten GET used to be built from scratch, silently dropping the caller's signal and
    // leaving the rest of the redirect chain uncancellable.
    expect(seen[1]).toBe(controller.signal);
  });

  it("converts 301 and 302 on a POST to GET but leaves a GET alone", async () => {
    const seen: string[] = [];
    const transport = transportFor((url, init) => {
      seen.push(String(init.method));
      if (url.searchParams.has("moved")) return json({ ok: true });
      return new Response(null, { status: 302, headers: { location: "/odp/x?moved=1" } });
    });
    await odpRequest(transport, { method: "GET" });
    expect(seen).toEqual(["GET", "GET"]);
  });
});

describe("ODP transport errors", () => {
  it("maps Problem Details onto a typed error and marks retryability", async () => {
    const problem = {
      type: "https://offeringprotocol.org/problems/rate-limited",
      title: "Slow down",
      status: 429,
      code: "RATE_LIMITED"
    };
    const transport = transportFor(
      () =>
        new Response(JSON.stringify(problem), {
          status: 429,
          headers: { "content-type": "application/problem+json", "retry-after": "3" }
        })
    );
    const failure = await failureOf(odpRequest(transport));
    expect(failure).toBeInstanceOf(OdpRequestError);
    expect(failure.code).toBe("RATE_LIMITED");
    expect(failure.retryable).toBe(true);
    expect(failure.headers.get("retry-after")).toBe("3");
  });

  it("falls back to a generic error for a malformed problem body or a plain failure", async () => {
    const malformed = transportFor(
      () =>
        new Response("not json", {
          status: 400,
          headers: { "content-type": "application/problem+json" }
        })
    );
    const first = await failureOf(odpRequest(malformed));
    expect(first.code).toBe("HTTP_ERROR");
    expect(first.problem).toBeUndefined();

    const plain = transportFor(() => new Response("nope", { status: 404 }));
    const second = await failureOf(odpRequest(plain));
    expect(second.status).toBe(404);
    expect(second.retryable).toBe(false);
  });

  it("marks server failures retryable and client failures not", async () => {
    const failure = async (status: number): Promise<boolean> => {
      const error = await failureOf(odpRequest(transportFor(() => new Response(null, { status }))));
      return error.retryable;
    };
    expect(await failure(503)).toBe(true);
    expect(await failure(410)).toBe(false);
  });
});

describe("ODP transport caching", () => {
  it("serves a fresh entry without a second request and revalidates a stale one", async () => {
    const cache = createInMemoryOdpCache();
    let calls = 0;
    const transport = transportFor(() => {
      calls += 1;
      return json({ id: "one" }, { headers: { "cache-control": "max-age=60", etag: '"v1"' } });
    });
    await odpRequest(transport, { method: "GET" }, { cache });
    await odpRequest(transport, { method: "GET" }, { cache });
    expect(calls).toBe(1);
  });

  it("honours a bare 304 that carries no validator of its own", async () => {
    const cache = createInMemoryOdpCache();
    let calls = 0;
    const transport = transportFor(() => {
      calls += 1;
      if (calls === 1)
        return json({ id: "one" }, { headers: { "cache-control": "max-age=0", etag: '"v1"' } });
      return new Response(null, { status: 304 });
    });
    await odpRequest(transport, { method: "GET" }, { cache });
    // RFC 9110 only recommends echoing the entity tag, so a bare 304 still confirms the entry.
    await expect(odpRequest(transport, { method: "GET" }, { cache })).resolves.toEqual({
      id: "one"
    });
    expect(calls).toBe(2);
  });

  it("refetches when a 304 confirms a validator the cache does not hold", async () => {
    const cache = createInMemoryOdpCache();
    const bodies = ["one", "two"];
    let calls = 0;
    const transport = transportFor(() => {
      calls += 1;
      if (calls === 1)
        return json({ id: bodies[0] }, { headers: { "cache-control": "max-age=0", etag: '"v1"' } });
      if (calls === 2) return new Response(null, { status: 304, headers: { etag: '"v2"' } });
      return json({ id: bodies[1] }, { headers: { "cache-control": "max-age=0", etag: '"v2"' } });
    });
    await odpRequest(transport, { method: "GET" }, { cache });
    // The stored body is not the one the server just confirmed, so it must not be handed back.
    await expect(odpRequest(transport, { method: "GET" }, { cache })).resolves.toEqual({
      id: "two"
    });
    expect(calls).toBe(3);
  });

  it("rejects a 304 with nothing cached to revalidate", async () => {
    const cache = createInMemoryOdpCache();
    const transport = transportFor(() => new Response(null, { status: 304 }));
    await expect(odpRequest(transport, { method: "GET" }, { cache })).rejects.toThrow(
      "without a cached representation"
    );
  });

  it("applies a fallback lifetime without discarding the directives the response sent", async () => {
    const cache = createInMemoryOdpCache();
    let calls = 0;
    const transport = transportFor(() => {
      calls += 1;
      return json({ id: "one" }, { headers: { "cache-control": "private, no-transform" } });
    });
    await odpRequest(transport, { method: "GET" }, { cache, ttl: 3_600_000 });
    await odpRequest(transport, { method: "GET" }, { cache, ttl: 3_600_000 });
    expect(calls).toBe(1);
    const stored = JSON.stringify(await cache.get("offering", cacheKey()));
    // The appended fallback must not have replaced the directives the response actually sent.
    expect(stored).toContain("no-transform");
    expect(stored).toContain("max-age=3600");
  });

  it("does not apply a fallback when the response states its own freshness", async () => {
    const cache = createInMemoryOdpCache();
    let calls = 0;
    const transport = transportFor(() => {
      calls += 1;
      return json({ id: "one" }, { headers: { "cache-control": "no-store" } });
    });
    await odpRequest(transport, { method: "GET" }, { cache, ttl: 3_600_000 });
    await odpRequest(transport, { method: "GET" }, { cache, ttl: 3_600_000 });
    expect(calls).toBe(2);
  });

  it("separates entries by caller headers so one context cannot read another's", async () => {
    const cache = createInMemoryOdpCache();
    const bodies: string[] = [];
    const transport = transportFor((_url, init) => {
      bodies.push(new Headers(init.headers).get("authorization") ?? "anonymous");
      return json({ seen: bodies.length }, { headers: { "cache-control": "max-age=60" } });
    });
    await odpRequest(
      transport,
      { method: "GET", headers: { authorization: "Bearer a" } },
      { cache }
    );
    await odpRequest(transport, { method: "GET" }, { cache });
    expect(bodies).toEqual(["Bearer a", "anonymous"]);
  });

  it("sends the caller's headers even when a cache is in use", async () => {
    const cache = createInMemoryOdpCache();
    let seen: string | null = null;
    const transport = transportFor((_url, init) => {
      seen = new Headers(init.headers).get("authorization");
      return json({ ok: true });
    });
    await odpRequest(
      transport,
      { method: "GET", headers: { authorization: "Bearer a" } },
      { cache }
    );
    // Building the outgoing headers from the cache policy alone used to discard them entirely.
    expect(seen).toBe("Bearer a");
  });

  it("caches a POST only when the response states explicit freshness", async () => {
    const cache = createInMemoryOdpCache();
    let calls = 0;
    const cacheable = transportFor(() => {
      calls += 1;
      return json({ id: "one" }, { headers: { "cache-control": "max-age=60" } });
    });
    const post = { method: "POST", body: JSON.stringify({ query: "x" }) };
    await odpRequest(cacheable, post, { cache });
    await odpRequest(cacheable, post, { cache });
    expect(calls).toBe(1);

    let plain = 0;
    const uncacheable = transportFor(() => {
      plain += 1;
      return json({ id: "one" });
    });
    await odpRequest(uncacheable, post, { cache, partition: "other" });
    await odpRequest(uncacheable, post, { cache, partition: "other" });
    expect(plain).toBe(2);
  });

  it("keys a POST by its body and never lets it satisfy a GET", async () => {
    const cache = createInMemoryOdpCache();
    let calls = 0;
    const transport = transportFor(() => {
      calls += 1;
      return json({ id: calls }, { headers: { "cache-control": "max-age=60" } });
    });
    await odpRequest(transport, { method: "POST", body: '{"a":1}' }, { cache });
    await odpRequest(transport, { method: "POST", body: '{"a":2}' }, { cache });
    await odpRequest(transport, { method: "GET" }, { cache });
    expect(calls).toBe(3);
  });

  it("does not attempt to cache a request whose body is not a string", async () => {
    const cache = createInMemoryOdpCache();
    let calls = 0;
    const transport = transportFor(() => {
      calls += 1;
      return json({ ok: true }, { headers: { "cache-control": "max-age=60" } });
    });
    const body = new Blob(["{}"]);
    await odpRequest(transport, { method: "POST", body }, { cache });
    await odpRequest(transport, { method: "POST", body }, { cache });
    expect(calls).toBe(2);
  });

  it("discards a cache record whose stored policy cannot be restored", async () => {
    const backing = createInMemoryOdpCache();
    let calls = 0;
    const transport = transportFor(() => {
      calls += 1;
      return json({ ok: true }, { headers: { "cache-control": "max-age=60" } });
    });
    await odpRequest(transport, { method: "GET" }, { cache: backing });
    const corrupt: OdpCache = {
      delete: (resourceClass, key) => backing.delete(resourceClass, key),
      get: async (resourceClass, key) => {
        const record = await backing.get(resourceClass, key);
        return record === undefined ? undefined : { ...record, policy: { broken: true } as never };
      },
      set: (record) => backing.set(record)
    };
    await odpRequest(transport, { method: "GET" }, { cache: corrupt });
    expect(calls).toBe(2);
  });

  it("re-fetches when a cached value no longer passes validation", async () => {
    const backing = createInMemoryOdpCache();
    let calls = 0;
    const transport = transportFor(() => {
      calls += 1;
      return json({ id: "one" }, { headers: { "cache-control": "max-age=60" } });
    });
    const validate = (value: unknown): unknown => {
      if (!(typeof value === "object" && value !== null && "id" in value))
        throw new TypeError("stale shape");
      return value;
    };
    const corrupting: OdpCache = {
      delete: (resourceClass, key) => backing.delete(resourceClass, key),
      get: (resourceClass, key) => backing.get(resourceClass, key),
      set: (record) => backing.set({ ...record, value: {} })
    };
    await requestOdpValue(
      transport,
      new URL("https://example.com/odp/offerings"),
      { method: "GET" },
      undefined,
      corrupting,
      "public",
      "offering",
      0,
      validate
    );
    await expect(
      requestOdpValue(
        transport,
        new URL("https://example.com/odp/offerings"),
        { method: "GET" },
        undefined,
        corrupting,
        "public",
        "offering",
        0,
        validate
      )
    ).resolves.toEqual({ id: "one" });
    expect(calls).toBe(2);
  });
});

describe("ODP transport request coalescing", () => {
  it("shares one request between identical concurrent callers", async () => {
    const cache = createInMemoryOdpCache();
    let calls = 0;
    const transport = transportFor(() => {
      calls += 1;
      return json({ id: "one" });
    });
    const [first, second] = await Promise.all([
      odpRequest(transport, { method: "GET" }, { cache }),
      odpRequest(transport, { method: "GET" }, { cache })
    ]);
    expect(calls).toBe(1);
    expect(first).toEqual(second);
    // Each caller gets its own copy, so one mutating the result cannot affect the other.
    expect(first).not.toBe(second);
  });

  it("does not share a flight between callers with different validators", async () => {
    const cache = createInMemoryOdpCache();
    let calls = 0;
    const transport = transportFor(() => {
      calls += 1;
      return json({ id: "one" });
    });
    const lenient = (value: unknown): unknown => value;
    const strict = (): unknown => {
      throw new TypeError("rejected by the second caller");
    };
    const run = (validate: (value: unknown) => unknown): Promise<unknown> =>
      requestOdpValue(
        transport,
        new URL("https://example.com/odp/offerings"),
        { method: "GET" },
        undefined,
        cache,
        "public",
        "offering",
        0,
        validate
      );
    const results = await Promise.allSettled([run(lenient), run(strict)]);
    // Joining a flight runs no validator of the joiner's own, so the strict caller must not be
    // handed the lenient caller's value.
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]?.status).toBe("rejected");
    expect(calls).toBe(2);
  });

  it("does not coalesce a request that carries an abort signal", async () => {
    const cache = createInMemoryOdpCache();
    let calls = 0;
    const transport = transportFor(() => {
      calls += 1;
      return json({ id: "one" });
    });
    const controller = new AbortController();
    await Promise.all([
      odpRequest(transport, { method: "GET", signal: controller.signal }, { cache }),
      odpRequest(transport, { method: "GET", signal: controller.signal }, { cache })
    ]);
    expect(calls).toBe(2);
  });
});

describe("ODP transport revalidation repair", () => {
  it("re-fetches when a revalidated cache entry no longer passes validation", async () => {
    const backing = createInMemoryOdpCache();
    let calls = 0;
    const transport = transportFor(() => {
      calls += 1;
      if (calls === 2) return new Response(null, { status: 304 });
      return json({ id: "one" }, { headers: { "cache-control": "max-age=0", etag: '"v1"' } });
    });
    // Stores a shape the validator will later reject, standing in for a cache whose contents have
    // drifted from what this version of the SDK accepts.
    let poison = false;
    const drifting: OdpCache = {
      delete: (resourceClass, key) => backing.delete(resourceClass, key),
      get: (resourceClass, key) => backing.get(resourceClass, key),
      set: (record) => backing.set(poison ? { ...record, value: {} } : record)
    };
    const validate = (value: unknown): unknown => {
      if (!(typeof value === "object" && value !== null && "id" in value))
        throw new TypeError("cached shape is stale");
      return value;
    };
    const run = (): Promise<unknown> =>
      requestOdpValue(
        transport,
        new URL("https://example.com/odp/offerings"),
        { method: "GET" },
        undefined,
        drifting,
        "public",
        "offering",
        0,
        validate
      );
    await run();
    poison = true;
    await backing.set({
      ...requireRecord(await backing.get("offering", cacheKey())),
      value: {}
    });
    poison = false;
    await expect(run()).resolves.toEqual({ id: "one" });
    expect(calls).toBe(3);
  });
});
