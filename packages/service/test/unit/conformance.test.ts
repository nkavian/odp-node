import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Offering, PageEnvelope, TerseOffering } from "@offering-protocol/core";

import {
  createOdpService,
  createStaticCatalog,
  OdpServiceError,
  selectLanguage,
  type OdpCatalog,
  type OdpService,
  type OdpServiceDocumentConfig
} from "../../src/index.js";

const BASE: OdpServiceDocumentConfig = {
  name: "Example",
  description: "Example catalog",
  language: "en",
  localizations: ["en"],
  http: { endpoint_base: "/odp" }
};

const MULTILINGUAL: OdpServiceDocumentConfig = {
  ...BASE,
  localizations: ["en", "fr-CA", "de-DE"]
};

/** The two handlers every ODP Service must provide, answering with nothing. */
const EMPTY = {
  listOfferings: () => ({ odp_version: "1.0" as const, items: [] }),
  getOffering: () => undefined
};

function serviceOf(
  catalog: OdpCatalog,
  document: OdpServiceDocumentConfig = BASE,
  onError?: (error: unknown, request: Request) => void
): OdpService {
  return createOdpService({
    catalog,
    document,
    ...(onError === undefined ? {} : { onError })
  });
}

function get(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function items(page: Record<string, unknown>): Record<string, unknown>[] {
  return page["items"] as Record<string, unknown>[];
}

/** A page shaped the way a buggy Service produces one, past the types that forbid it. */
function malformedPage(value: Record<string, unknown>): PageEnvelope<Offering | TerseOffering> {
  return value as PageEnvelope<Offering | TerseOffering>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HTTP semantics", () => {
  it("answers HEAD with the GET headers and no body", async () => {
    const odp = serviceOf(EMPTY);
    const head = await odp.fetch(
      new Request("https://example.com/.well-known/odp", { method: "HEAD" })
    );
    const full = await odp.fetch(get("https://example.com/.well-known/odp"));
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers.get("etag")).toMatch(/^"[A-Za-z0-9_-]{27}"$/u);
    expect(head.headers.get("etag")).toBe(full.headers.get("etag"));
    expect(head.headers.get("content-type")).toBe("application/odp+json");
  });

  it("strips the body from every HEAD response, including Problem Details", async () => {
    const odp = serviceOf({ ...EMPTY, searchOfferings: () => ({ odp_version: "1.0", items: [] }) });
    const head = (path: string, method = "HEAD"): Request =>
      new Request(`https://example.com${path}`, { method });

    const missing = await odp.fetch(head("/odp/nowhere"));
    expect(missing.status).toBe(404);
    expect(missing.body).toBeNull();
    const refused = await odp.fetch(head("/odp/offerings", "DELETE"));
    expect(refused.status).toBe(405);
    // A refusal still has to describe what the resource does allow.
    expect(refused.headers.get("allow")).toBe("GET, HEAD");
    const invalid = await odp.fetch(head("/odp/offerings?limit=0"));
    expect(invalid.status).toBe(400);
    expect(invalid.body).toBeNull();
  });

  it("serves HEAD on a search continuation as the GET it mirrors", async () => {
    const odp = serviceOf({ ...EMPTY, searchOfferings: () => ({ odp_version: "1.0", items: [] }) });
    const target = "https://example.com/odp/offerings/search?cursor=opaque";
    const read = await odp.fetch(get(target));
    const head = await odp.fetch(new Request(target, { method: "HEAD" }));
    expect(read.status).toBe(200);
    expect(head.status).toBe(200);
    expect(head.headers.get("etag")).toBe(read.headers.get("etag"));
  });

  it("enumerates every supported method when refusing one", async () => {
    const odp = serviceOf({ ...EMPTY, searchOfferings: () => ({ odp_version: "1.0", items: [] }) });
    const list = await odp.fetch(
      new Request("https://example.com/odp/offerings", { method: "DELETE" })
    );
    expect(list.status).toBe(405);
    expect(list.headers.get("allow")).toBe("GET, HEAD");
    const search = await odp.fetch(
      new Request("https://example.com/odp/offerings/search", { method: "PUT" })
    );
    expect(search.status).toBe(405);
    expect(search.headers.get("allow")).toBe("GET, POST, HEAD");
    const document = await odp.fetch(
      new Request("https://example.com/.well-known/odp", { method: "POST" })
    );
    expect(document.status).toBe(405);
  });

  it("treats an explicitly unacceptable media range as unacceptable", async () => {
    const odp = serviceOf(EMPTY);
    // RFC 9110: `q=0` says the range is *not* acceptable, which a naive substring test misses.
    expect(
      (
        await odp.fetch(
          get("https://example.com/odp/offerings", { accept: "application/odp+json;q=0" })
        )
      ).status
    ).toBe(406);
    expect(
      (await odp.fetch(get("https://example.com/odp/offerings", { accept: "*/*;q=0.0" }))).status
    ).toBe(406);
    expect(
      (await odp.fetch(get("https://example.com/odp/offerings", { accept: "application/*" })))
        .status
    ).toBe(200);
    expect(
      (
        await odp.fetch(
          get("https://example.com/odp/offerings", {
            accept: "text/html;q=0.9, application/odp+json"
          })
        )
      ).status
    ).toBe(200);
  });

  it("serves a strong validator and honours conditional retrieval", async () => {
    const odp = serviceOf(EMPTY);
    const first = await odp.fetch(get("https://example.com/odp/offerings"));
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{27}"$/u);
    expect(first.headers.get("vary")).toBe("Accept, Accept-Language");

    for (const header of [etag ?? "", `W/${etag ?? ""}`, "*", `"other", ${etag ?? ""}`]) {
      const conditional = await odp.fetch(
        get("https://example.com/odp/offerings", { "if-none-match": header })
      );
      expect(conditional.status).toBe(304);
      expect(conditional.headers.get("etag")).toBe(etag);
    }
    const stale = await odp.fetch(
      get("https://example.com/odp/offerings", { "if-none-match": '"stale"' })
    );
    expect(stale.status).toBe(200);
  });

  it("gives different representations different validators", async () => {
    const odp = serviceOf({
      ...EMPTY,
      getOffering: (id, request) =>
        request.representation === "full"
          ? {
              odp_version: "1.0" as const,
              id,
              name: "Widget",
              schema: { url: "/schemas/widget.json" },
              attributes: { size: 1 }
            }
          : { odp_version: "1.0" as const, id, name: "Widget" }
    });
    const terse = await odp.fetch(
      get("https://example.com/odp/offerings/widget?representation=terse")
    );
    const full = await odp.fetch(
      get("https://example.com/odp/offerings/widget?representation=full")
    );
    expect(terse.status).toBe(200);
    expect(full.status).toBe(200);
    expect(terse.headers.get("etag")).toMatch(/^"[A-Za-z0-9_-]{27}"$/u);
    expect(full.headers.get("etag")).toMatch(/^"[A-Za-z0-9_-]{27}"$/u);
    expect(terse.headers.get("etag")).not.toBe(full.headers.get("etag"));
  });

  it("gives two language variants of one body different validators", async () => {
    const odp = serviceOf(EMPTY, MULTILINGUAL);
    const url = "https://example.com/odp/offerings";
    const french = await odp.fetch(get(url, { "accept-language": "fr-CA" }));
    const english = await odp.fetch(get(url, { "accept-language": "en" }));
    // SVC-61: a catalog that does not localize this page returns identical bytes for both, so the
    // validator covers the negotiated language as well as the body.
    expect(french.headers.get("content-language")).toBe("fr-CA");
    expect(english.headers.get("content-language")).toBe("en");
    expect(french.headers.get("etag")).not.toBe(english.headers.get("etag"));
    const crossed = await odp.fetch(
      get(url, { "accept-language": "en", "if-none-match": french.headers.get("etag") ?? "" })
    );
    expect(crossed.status).toBe(200);
  });

  it("answers a matched validator on a POST with 412 rather than 304", async () => {
    const odp = serviceOf({ ...EMPTY, searchOfferings: () => ({ odp_version: "1.0", items: [] }) });
    const search = (headers: Record<string, string>): Request =>
      new Request("https://example.com/odp/offerings/search", {
        method: "POST",
        headers: { "content-type": "application/odp+json", ...headers },
        body: JSON.stringify({ odp_version: "1.0", query: "x" })
      });
    const initial = await odp.fetch(search({}));
    const etag = initial.headers.get("etag") ?? "";
    // RFC 9110 reserves 304 for GET and HEAD; every other method fails the precondition instead.
    const repeated = await odp.fetch(search({ "if-none-match": etag }));
    expect(repeated.status).toBe(412);
    await expect(repeated.json()).resolves.toMatchObject({ code: "PRECONDITION_FAILED" });
    const wildcard = await odp.fetch(search({ "if-none-match": "*" }));
    expect(wildcard.status).toBe(412);
  });

  it("marks a response an operation can authenticate as private to its caller", async () => {
    const odp = createOdpService({
      catalog: EMPTY,
      document: { ...BASE, protocols: { enrollment: [{ name: "aep" }] } },
      operationAuthentication: { "list-offerings": "required" }
    });
    const authenticated = await odp.fetch(get("https://example.com/odp/offerings"));
    // A shared cache can only avoid reusing this across authentication contexts if told to.
    expect(authenticated.headers.get("vary")).toBe("Accept, Accept-Language, Authorization");
    expect(authenticated.headers.get("cache-control")).toBe("private");
    const open = await odp.fetch(get("https://example.com/.well-known/odp"));
    expect(open.headers.get("vary")).toBe("Accept, Accept-Language");
    expect(open.headers.get("cache-control")).toBeNull();
  });
});

describe("Language negotiation", () => {
  it("selects an advertised localization by RFC 4647 Lookup", async () => {
    const odp = serviceOf(EMPTY, MULTILINGUAL);
    const exact = await odp.fetch(
      get("https://example.com/odp/offerings", { "accept-language": "fr-CA" })
    );
    expect(exact.headers.get("content-language")).toBe("fr-CA");
    // Lookup truncates the range at subtag boundaries, skipping singleton extensions.
    const truncated = await odp.fetch(
      get("https://example.com/odp/offerings", { "accept-language": "fr-CA-x-private" })
    );
    expect(truncated.headers.get("content-language")).toBe("fr-CA");
    const wildcard = await odp.fetch(
      get("https://example.com/odp/offerings", { "accept-language": "*" })
    );
    expect(wildcard.headers.get("content-language")).toBe("en");
  });

  it("falls back to the default language rather than refusing the request", async () => {
    const odp = serviceOf(EMPTY, MULTILINGUAL);
    // SVC-59: an unmatched preference is served in the default language, not answered `406`.
    const unmatched = await odp.fetch(
      get("https://example.com/odp/offerings", { "accept-language": "es-MX" })
    );
    expect(unmatched.status).toBe(200);
    expect(unmatched.headers.get("content-language")).toBe("en");
    const none = await odp.fetch(get("https://example.com/odp/offerings"));
    expect(none.headers.get("content-language")).toBe("en");
  });

  it("orders ranges by quality and discards those refused outright", async () => {
    const odp = serviceOf(EMPTY, MULTILINGUAL);
    const ordered = await odp.fetch(
      get("https://example.com/odp/offerings", { "accept-language": "de-DE;q=0.2, fr-CA;q=0.8" })
    );
    expect(ordered.headers.get("content-language")).toBe("fr-CA");
    const refused = await odp.fetch(
      get("https://example.com/odp/offerings", { "accept-language": "de-DE;q=0, fr-CA;q=0.1" })
    );
    expect(refused.headers.get("content-language")).toBe("fr-CA");
  });

  it("reports the language the resource itself declares", async () => {
    const odp = serviceOf(
      {
        ...EMPTY,
        getOffering: (id) => ({
          odp_version: "1.0" as const,
          id,
          name: "Chariot",
          language: "fr-CA",
          localizations: ["fr-CA"]
        })
      },
      MULTILINGUAL
    );
    const response = await odp.fetch(
      get("https://example.com/odp/offerings/chariot", { "accept-language": "de-DE" })
    );
    expect(response.headers.get("content-language")).toBe("fr-CA");
  });

  it("passes the selected language, not the raw header, to the catalog", async () => {
    const listOfferings = vi.fn(() => ({ odp_version: "1.0" as const, items: [] }));
    const odp = serviceOf({ ...EMPTY, listOfferings }, MULTILINGUAL);
    await odp.fetch(
      get("https://example.com/odp/offerings", { "accept-language": "de-DE;q=0.9, es;q=1.0" })
    );
    expect(listOfferings).toHaveBeenCalledWith(expect.objectContaining({ language: "de-DE" }));
  });

  it("exposes Lookup on its own for Services that negotiate elsewhere", () => {
    expect(selectLanguage(null, "en", ["en"])).toBeUndefined();
    expect(selectLanguage("", "en", ["en"])).toBeUndefined();
    expect(selectLanguage("zh-Hant-TW", "en", ["zh-Hant"])).toBe("zh-Hant");
    // Lookup never widens a range to a more specific tag.
    expect(selectLanguage("fr", "en", ["fr-CA"])).toBeUndefined();
    expect(selectLanguage("FR-ca", "en", ["fr-CA"])).toBe("fr-CA");
    // A malformed quality parameter is not a refusal, so the range keeps its default weight.
    // RFC 9110 §12.4.2 defines the quality grammar; a value outside it carries no weight, so it
    // cannot outrank a well-formed entry by defaulting to 1.
    expect(selectLanguage("en;q=notanumber", "en", ["en"])).toBeUndefined();
    expect(selectLanguage("en;q=1.5", "en", ["en"])).toBeUndefined();
    expect(selectLanguage("de-DE;q=abc, fr-CA;q=0.9", "en", ["de-DE", "fr-CA"])).toBe("fr-CA");
    expect(selectLanguage("en,,fr-CA", "en", ["fr-CA"])).toBe("fr-CA");
    expect(selectLanguage("en;q=0.5", "en", ["en"])).toBe("en");
  });
});

describe("Request validation", () => {
  it("accepts only the `limit` grammar the protocol defines", async () => {
    const odp = serviceOf(EMPTY);
    for (const value of ["0", "101", "1e2", "abc", "-1", " 5", "01.0", "1000"]) {
      const response = await odp.fetch(
        get(`https://example.com/odp/offerings?limit=${encodeURIComponent(value)}`)
      );
      expect(response.status, value).toBe(400);
    }
    expect((await odp.fetch(get("https://example.com/odp/offerings?limit=100"))).status).toBe(200);
    expect((await odp.fetch(get("https://example.com/odp/offerings?limit=001"))).status).toBe(200);
  });

  it("refuses repeated single-valued query parameters", async () => {
    const odp = serviceOf(EMPTY);
    for (const query of [
      "limit=1&limit=2",
      "cursor=a&cursor=b",
      "representation=terse&representation=full"
    ])
      expect((await odp.fetch(get(`https://example.com/odp/offerings?${query}`))).status).toBe(400);
    expect(
      (await odp.fetch(get("https://example.com/odp/offerings?representation=brief"))).status
    ).toBe(400);
  });

  it("rejects identifiers that are not path-safe local identifiers", async () => {
    const odp = serviceOf(EMPTY);
    // A lone `%` is not decodable; a decoded space is not a Local Resource Identifier.
    expect((await odp.fetch(get("https://example.com/odp/offerings/%E0%A4%A"))).status).toBe(400);
    expect((await odp.fetch(get("https://example.com/odp/offerings/one%20two"))).status).toBe(400);
    // An encoded separator reaches the handler as one segment and must not decode into a path.
    expect((await odp.fetch(get("https://example.com/odp/offerings/a%2F..%2Fb"))).status).toBe(400);
  });

  it("rejects request bodies that are not well-formed ODP JSON", async () => {
    const odp = serviceOf({ ...EMPTY, searchOfferings: () => ({ odp_version: "1.0", items: [] }) });
    const post = (init: RequestInit): Request =>
      new Request("https://example.com/odp/offerings/search", { method: "POST", ...init });

    expect(
      (await odp.fetch(post({ headers: { "content-type": "application/json" }, body: "{}" })))
        .status
    ).toBe(415);
    expect(
      (
        await odp.fetch(
          post({ headers: { "content-type": "application/odp+json" }, body: "{not json" })
        )
      ).status
    ).toBe(400);
    const invalidUtf8 = await odp.fetch(
      post({
        headers: { "content-type": "application/odp+json" },
        body: new Uint8Array([0xff, 0xfe, 0xfd])
      })
    );
    expect(invalidUtf8.status).toBe(400);
    expect(invalidUtf8.headers.get("content-type")).toBe("application/problem+json");
    await expect(invalidUtf8.json()).resolves.toMatchObject({ code: "INVALID_REQUEST" });
    expect(
      (
        await odp.fetch(
          post({
            headers: { "content-type": "application/odp+json", "content-length": "70000" },
            body: JSON.stringify({ odp_version: "1.0", query: "x" })
          })
        )
      ).status
    ).toBe(413);
    // An unparseable Content-Length says nothing, so the stream is measured as it arrives.
    expect(
      (
        await odp.fetch(
          post({
            headers: { "content-type": "application/odp+json", "content-length": "many" },
            body: JSON.stringify({ odp_version: "1.0", query: "x" })
          })
        )
      ).status
    ).toBe(200);
    expect(
      (await odp.fetch(post({ headers: { "content-type": "application/odp+json" } }))).status
    ).toBe(400);
  });

  it("requires a cursor on a GET search continuation", async () => {
    const odp = serviceOf({
      ...EMPTY,
      searchOfferings: () => ({ odp_version: "1.0", items: [] }),
      searchCollections: () => ({ odp_version: "1.0", items: [] })
    });
    expect((await odp.fetch(get("https://example.com/odp/offerings/search"))).status).toBe(400);
    expect((await odp.fetch(get("https://example.com/odp/collections/search"))).status).toBe(400);
  });

  it("answers 404 for paths and operations the Service does not expose", async () => {
    const odp = serviceOf(EMPTY);
    expect((await odp.fetch(get("https://example.com/elsewhere"))).status).toBe(404);
    expect((await odp.fetch(get("https://example.com/odp/unknown"))).status).toBe(404);
    expect((await odp.fetch(get("https://example.com/odp/offerings/a/b"))).status).toBe(404);
    for (const path of [
      "/odp/collections",
      "/odp/collections/search?cursor=c",
      "/odp/collections/plants",
      "/odp/collections/plants/offerings",
      "/odp/offerings/search?cursor=c"
    ])
      expect((await odp.fetch(get(`https://example.com${path}`))).status, path).toBe(404);
  });
});

describe("Collection operations", () => {
  const catalog: OdpCatalog = {
    ...EMPTY,
    listCollections: () => ({
      odp_version: "1.0",
      items: [{ id: "plants", name: "Plants" }]
    }),
    searchCollections: (query) => ({
      odp_version: "1.0",
      items: [{ id: query === undefined ? "continued" : "searched", name: "Result" }]
    }),
    getCollection: (id) => ({ odp_version: "1.0", id, name: "Plants" }),
    listCollectionOfferings: (id) => ({
      odp_version: "1.0",
      items: [{ id: `${id}-1`, name: "Item" }]
    })
  };

  it("advertises every handler the catalog implements", () => {
    expect(serviceOf(catalog).document.operations.map(({ name }) => name)).toEqual([
      "get-collection",
      "get-offering",
      "list-collection-offerings",
      "list-collections",
      "list-offerings",
      "search-collections"
    ]);
  });

  it("serves Collection listing, search, detail and member Offerings", async () => {
    const odp = serviceOf(catalog);
    expect(
      items(await body(await odp.fetch(get("https://example.com/odp/collections"))))[0]
    ).toEqual({
      id: "plants",
      name: "Plants"
    });
    const searched = await odp.fetch(
      new Request("https://example.com/odp/collections/search", {
        method: "POST",
        headers: { "content-type": "application/odp+json" },
        body: JSON.stringify({ odp_version: "1.0", query: "plants", limit: 5 })
      })
    );
    expect(items(await body(searched))[0]?.["id"]).toBe("searched");
    const continued = await odp.fetch(get("https://example.com/odp/collections/search?cursor=c"));
    expect(items(await body(continued))[0]?.["id"]).toBe("continued");
    const members = await body(
      await odp.fetch(get("https://example.com/odp/collections/plants/offerings"))
    );
    expect(items(members)[0]?.["id"]).toBe("plants-1");
  });

  it("reports a missing Collection as 404 and a mismatched one as a Service fault", async () => {
    expect(
      (
        await serviceOf({ ...catalog, getCollection: () => undefined }).fetch(
          get("https://example.com/odp/collections/plants")
        )
      ).status
    ).toBe(404);
    expect(
      (
        await serviceOf({
          ...catalog,
          getCollection: () => ({ odp_version: "1.0", id: "other", name: "X" })
        }).fetch(get("https://example.com/odp/collections/plants"))
      ).status
    ).toBe(500);
  });
});

describe("Response conformance", () => {
  it("strips the inherited version from every page item", async () => {
    const item = {
      odp_version: "1.0" as const,
      id: "a",
      name: "A",
      schema: { url: "/schemas/a.json" },
      attributes: { size: 1 }
    };
    const odp = serviceOf({
      listOfferings: () => ({ odp_version: "1.0", items: [item] }),
      getOffering: () => item
    });
    // VER-03: a nested item inherits the container's version; restating it makes this SDK's own
    // Agent reject the page.
    for (const representation of ["terse", "full"]) {
      const page = await body(
        await odp.fetch(get(`https://example.com/odp/offerings?representation=${representation}`))
      );
      expect(items(page)[0], representation).not.toHaveProperty("odp_version");
    }
    const detail = await body(await odp.fetch(get("https://example.com/odp/offerings/a")));
    expect(detail).toHaveProperty("odp_version", "1.0");
  });

  it("refuses to serve a page whose continuation reference is unusable", async () => {
    const cases: Record<string, string> = {
      empty: "",
      overlong: `/odp/offerings?cursor=${"a".repeat(2100)}`,
      "non-ASCII": "/odp/offerings?cursor=café",
      "cross-origin": "https://evil.example/odp/offerings",
      unparseable: "http://["
    };
    for (const [label, next] of Object.entries(cases)) {
      const odp = serviceOf({
        ...EMPTY,
        listOfferings: () => ({ odp_version: "1.0", items: [], next })
      });
      expect((await odp.fetch(get("https://example.com/odp/offerings"))).status, label).toBe(500);
    }
    const usable = serviceOf({
      ...EMPTY,
      listOfferings: () => ({
        odp_version: "1.0",
        items: [],
        next: "https://example.com/odp/offerings?cursor=c"
      })
    });
    expect((await usable.fetch(get("https://example.com/odp/offerings"))).status).toBe(200);
  });

  it("refuses a page whose items are not an array or whose next is not a string", async () => {
    const shapes: Record<string, Record<string, unknown>> = {
      "items object": { odp_version: "1.0", items: { "0": { id: "a", name: "A" } } },
      "numeric next": { odp_version: "1.0", items: [], next: 7 }
    };
    for (const [label, page] of Object.entries(shapes)) {
      const odp = serviceOf({ ...EMPTY, listOfferings: () => malformedPage(page) });
      expect((await odp.fetch(get("https://example.com/odp/offerings"))).status, label).toBe(500);
    }
  });

  it("validates the whole page envelope, not only its items", async () => {
    const odp = serviceOf({
      ...EMPTY,
      listOfferings: () => malformedPage({ odp_version: "1.0", items: [], auth_expands: false })
    });
    // REP-09 prohibits `auth_expands: false` outright, and the envelope is checked as a whole.
    expect((await odp.fetch(get("https://example.com/odp/offerings"))).status).toBe(500);
  });

  it("permits refinements only on the initial response of a search that asked for them", async () => {
    const refinements = [{ filter_id: "color", values: [{ value: "red", count: 3 }] }];
    const searchOfferings = () => ({ odp_version: "1.0" as const, items: [], refinements });
    const odp = serviceOf({ ...EMPTY, searchOfferings });
    const search = (value: Record<string, unknown>): Request =>
      new Request("https://example.com/odp/offerings/search", {
        method: "POST",
        headers: { "content-type": "application/odp+json" },
        body: JSON.stringify({ odp_version: "1.0", query: "x", ...value })
      });

    expect((await odp.fetch(search({ refinements: ["color"] }))).status).toBe(200);
    // OFR-14: refinements that were never requested.
    expect((await odp.fetch(search({}))).status).toBe(500);
    // FLT-30: a refinement group for a filter that was not among the requested ones.
    expect((await odp.fetch(search({ refinements: ["size"] }))).status).toBe(500);
    // OFR-15: a continuation response cannot carry refinements at all.
    expect((await odp.fetch(get("https://example.com/odp/offerings/search?cursor=c"))).status).toBe(
      500
    );
  });

  it("refuses to emit a document beyond its byte limit", async () => {
    const huge = {
      odp_version: "1.0" as const,
      id: "huge",
      name: "Huge",
      schema: { url: "/schemas/huge.json" },
      attributes: { blob: "x".repeat(600_000) }
    };
    const odp = serviceOf({
      ...EMPTY,
      getOffering: () => huge,
      listOfferings: () => ({ odp_version: "1.0", items: [huge] })
    });
    // ERR-19/ERR-21: an over-limit body is not merely nonconformant — a conformant Agent stops
    // reading it and reports a failure, so the Service must fail loudly instead.
    expect((await odp.fetch(get("https://example.com/odp/offerings/huge"))).status).toBe(500);
    expect((await odp.fetch(get("https://example.com/odp/offerings"))).status).toBe(500);
  });

  it("refuses to emit a document beyond its nesting-depth limit", async () => {
    let attributes: Record<string, unknown> = { leaf: 1 };
    for (let index = 0; index < 20; index += 1) attributes = { child: attributes };
    const odp = serviceOf({
      ...EMPTY,
      getOffering: (id) => ({
        odp_version: "1.0" as const,
        id,
        name: "Deep",
        schema: { url: "/schemas/deep.json" },
        attributes
      })
    });
    expect((await odp.fetch(get("https://example.com/odp/offerings/deep"))).status).toBe(500);
  });

  it("rejects a Full Representation that still advertises detail fields", async () => {
    const odp = serviceOf({
      ...EMPTY,
      getOffering: (id) => ({
        odp_version: "1.0" as const,
        id,
        name: "Widget",
        detail_fields: ["/attributes"]
      })
    });
    expect((await odp.fetch(get("https://example.com/odp/offerings/widget"))).status).toBe(500);
    expect(
      (await odp.fetch(get("https://example.com/odp/offerings/widget?representation=terse"))).status
    ).toBe(200);
  });

  it("rejects a Full Collection that still advertises detail fields", async () => {
    const odp = serviceOf({
      ...EMPTY,
      getCollection: (id) => ({
        odp_version: "1.0" as const,
        id,
        name: "Plants",
        detail_fields: ["/description"]
      })
    });
    expect((await odp.fetch(get("https://example.com/odp/collections/plants"))).status).toBe(500);
  });

  it("reports a missing Offering as 404", async () => {
    expect(
      (await serviceOf(EMPTY).fetch(get("https://example.com/odp/offerings/gone"))).status
    ).toBe(404);
  });

  it("keeps Problem Details inside their byte limit however long the title", async () => {
    const odp = serviceOf({
      ...EMPTY,
      listOfferings: () => {
        throw new OdpServiceError(400, "A".repeat(64), "𝔘".repeat(400));
      }
    });
    const response = await odp.fetch(get("https://example.com/odp/offerings"));
    const text = await response.text();
    expect(response.status).toBe(400);
    // ERR-21: the 128-code-point title bound is what keeps the document under 16,384 bytes.
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(16_384);
    const details = JSON.parse(text) as Record<string, unknown>;
    expect(details["code"]).toBe("A".repeat(64));
    expect([...String(details["title"])]).toHaveLength(128);
  });

  it("rejects a Terse Representation that carries Actions", async () => {
    const odp = serviceOf({
      ...EMPTY,
      getOffering: (id) => ({
        odp_version: "1.0" as const,
        id,
        name: "Widget",
        actions: [
          {
            authentication: "required" as const,
            id: "rent",
            rel: "purchase",
            http: { href: "/rent", method: "POST" as const }
          }
        ]
      })
    });
    expect(
      (await odp.fetch(get("https://example.com/odp/offerings/widget?representation=terse"))).status
    ).toBe(500);
  });
});

describe("Problem Details", () => {
  it("reports every failure as RFC 9457 Problem Details", async () => {
    const odp = serviceOf({ ...EMPTY, searchOfferings: () => ({ odp_version: "1.0", items: [] }) });
    const notFound = await odp.fetch(get("https://example.com/odp/nowhere"));
    expect(notFound.headers.get("content-type")).toBe("application/problem+json");
    await expect(notFound.json()).resolves.toEqual({
      type: "https://offeringprotocol.org/problems/not-found",
      title: "ODP resource not found",
      status: 404,
      code: "NOT_FOUND"
    });
    const oversized = await odp.fetch(
      new Request("https://example.com/odp/offerings/search", {
        method: "POST",
        headers: { "content-type": "application/odp+json" },
        body: "x".repeat(65_537)
      })
    );
    // ERR-31: an oversized ODP request is `413` with the `REQUEST_TOO_LARGE` code.
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({ code: "REQUEST_TOO_LARGE" });
  });

  it("attaches Retry-After to the statuses that require it", async () => {
    const throwing = (error: OdpServiceError): OdpCatalog => ({
      ...EMPTY,
      listOfferings: () => {
        throw error;
      }
    });
    const limited = await serviceOf(
      throwing(new OdpServiceError(429, "RATE_LIMITED", "Slow down"))
    ).fetch(get("https://example.com/odp/offerings"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");
    const unavailable = await serviceOf(
      throwing(new OdpServiceError(503, "UNAVAILABLE", "Down"))
    ).fetch(get("https://example.com/odp/offerings"));
    expect(unavailable.headers.get("retry-after")).toBe("1");
    const explicit = await serviceOf(
      throwing(new OdpServiceError(429, "RATE_LIMITED", "Slow down", { "retry-after": "30" }))
    ).fetch(get("https://example.com/odp/offerings"));
    expect(explicit.headers.get("retry-after")).toBe("30");
  });

  it("normalizes a status, code and title the Service supplied badly", async () => {
    const raise = (error: OdpServiceError): Promise<Response> =>
      serviceOf({
        ...EMPTY,
        listOfferings: () => {
          throw error;
        }
      }).fetch(get("https://example.com/odp/offerings"));

    const status = await raise(new OdpServiceError(200, "TEAPOT", "Not an error"));
    expect(status.status).toBe(500);
    const code = await raise(new OdpServiceError(400, "not a code", "Bad"));
    await expect(code.json()).resolves.toMatchObject({ code: "INTERNAL_ERROR", status: 400 });
    const blank = await raise(new OdpServiceError(409, "CONFLICT", "   "));
    await expect(blank.json()).resolves.toMatchObject({
      title: "ODP request failed with HTTP 409"
    });
    const long = await raise(new OdpServiceError(400, "INVALID_REQUEST", "é".repeat(400)));
    const bounded = await body(long);
    expect([...String(bounded["title"])]).toHaveLength(128);
  });

  it("still answers when building the Problem Details itself fails", async () => {
    // `problem` runs inside the catch that turns a failure into a response, so anything it throws
    // escapes `fetch` and rejects the caller's promise.
    const odp = serviceOf({
      ...EMPTY,
      listOfferings: () => {
        throw new OdpServiceError(400, "INVALID_REQUEST", "Bad", { "invalid header": "x" });
      }
    });
    const response = await odp.fetch(get("https://example.com/odp/offerings"));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("reports an unexpected catalog failure to the operator", async () => {
    const onError = vi.fn();
    const failure = new Error("database unreachable");
    const request = get("https://example.com/odp/offerings");
    const odp = serviceOf(
      {
        ...EMPTY,
        listOfferings: () => {
          throw failure;
        }
      },
      BASE,
      onError
    );
    const response = await odp.fetch(request);
    expect(response.status).toBe(500);
    // Without a hook an unexpected failure is indistinguishable from a healthy Service.
    expect(onError).toHaveBeenCalledWith(failure, request);
    await expect(response.json()).resolves.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("does not leak an internal failure message into the response", async () => {
    const odp = serviceOf({
      ...EMPTY,
      listOfferings: () => {
        throw new Error("connection string postgres://user:secret@db/catalog");
      }
    });
    await expect(
      (await odp.fetch(get("https://example.com/odp/offerings"))).json()
    ).resolves.toEqual({
      type: "https://offeringprotocol.org/problems/internal-error",
      title: "The ODP Service could not complete the request",
      status: 500,
      code: "INTERNAL_ERROR"
    });
  });
});

describe("Service Document construction", () => {
  it("requires the two baseline handlers", () => {
    const partial = (value: Record<string, unknown>): OdpCatalog => value as unknown as OdpCatalog;
    expect(() =>
      createOdpService({ catalog: partial({ getOffering: () => undefined }), document: BASE })
    ).toThrow("listOfferings and getOffering");
    expect(() =>
      createOdpService({
        catalog: partial({ listOfferings: () => ({ odp_version: "1.0", items: [] }) }),
        document: BASE
      })
    ).toThrow("listOfferings and getOffering");
  });

  it("refuses a Service Document beyond its nesting-depth limit", () => {
    let extension: Record<string, unknown> = { leaf: 1 };
    for (let index = 0; index < 10; index += 1) extension = { child: extension };
    // Core places no depth bound on Service-defined extension members.
    expect(() =>
      createOdpService({ catalog: EMPTY, document: { ...BASE, x_vendor: extension } })
    ).toThrow("nesting-depth limit");
  });

  it("refuses a Service Document beyond its byte limit", () => {
    const description = "d".repeat(1024);
    const filterId = (index: number): string => `filter-${"x".repeat(50)}-${String(index)}`;
    // Every field is within its own schema maximum, so core accepts the document and only the
    // document-wide byte budget catches it (SVC-83/SVC-84). An Agent stops reading an over-limit
    // document (ERR-20), so the Service refuses to publish one.
    const document: OdpServiceDocumentConfig = {
      ...BASE,
      search_capabilities: {
        filters: {
          inline: Array.from({ length: 32 }, (_value, index) => ({
            id: filterId(index),
            title: "t".repeat(128),
            description,
            type: "string" as const,
            operators: ["eq", "in", "lt", "lte", "gt", "gte", "exists"] as const
          }))
        },
        sorts: {
          inline: Array.from({ length: 16 }, (_value, index) => ({
            id: `sort-${"y".repeat(52)}-${String(index)}`,
            title: "t".repeat(128),
            description,
            keys: [0, 1, 2].map((offset) => ({
              filter_id: filterId((index * 3 + offset) % 32),
              direction: "ascending" as const,
              missing: "last" as const
            }))
          }))
        }
      }
    };
    expect(() =>
      createOdpService({
        catalog: { ...EMPTY, searchOfferings: () => ({ odp_version: "1.0", items: [] }) },
        document
      })
    ).toThrow("exceeds its limit");
  });

  it("tolerates an endpoint base with a trailing slash", async () => {
    const odp = serviceOf(EMPTY, { ...BASE, http: { endpoint_base: "/odp/" } });
    expect((await odp.fetch(get("https://example.com/odp/offerings"))).status).toBe(200);
  });

  it("hands back a copy of its document", async () => {
    const odp = serviceOf(EMPTY);
    odp.document.operations.length = 0;
    odp.document.name = "Hijacked";
    const served = await body(await odp.fetch(get("https://example.com/.well-known/odp")));
    expect(served["operations"]).toHaveLength(2);
    expect(served["name"]).toBe("Example");
  });
});

describe("Static catalog", () => {
  const first = {
    odp_version: "1.0" as const,
    id: "a",
    name: "A",
    schema: { url: "/schemas/a.json" },
    attributes: { size: 1 },
    actions: [
      {
        authentication: "not-required" as const,
        id: "buy",
        rel: "purchase",
        http: { href: "/buy", method: "POST" as const }
      }
    ]
  };
  const offerings = [first, { odp_version: "1.0" as const, id: "b", name: "B" }];
  const collections = [
    { odp_version: "1.0" as const, id: "plants", name: "Plants" },
    { odp_version: "1.0" as const, id: "ferns", name: "Ferns", parent_ids: ["plants"] }
  ];
  const classified = [
    ...offerings,
    { odp_version: "1.0" as const, id: "c", name: "C", collection_ids: ["plants"] }
  ];

  it("serves Collections, their members and full representations", async () => {
    const odp = serviceOf(createStaticCatalog({ collections, offerings: classified }));
    expect(
      items(await body(await odp.fetch(get("https://example.com/odp/collections"))))
    ).toHaveLength(2);
    const detail = await body(await odp.fetch(get("https://example.com/odp/collections/ferns")));
    expect(detail).toMatchObject({ id: "ferns", parent_ids: ["plants"] });
    const terse = await body(
      await odp.fetch(get("https://example.com/odp/collections/ferns?representation=terse"))
    );
    expect(terse).toMatchObject({ odp_version: "1.0", id: "ferns" });
    const members = await body(
      await odp.fetch(get("https://example.com/odp/collections/plants/offerings"))
    );
    expect(items(members).map((item) => item["id"])).toEqual(["c"]);
    const full = await body(
      await odp.fetch(get("https://example.com/odp/offerings?representation=full"))
    );
    expect(items(full)).toHaveLength(3);
    // REP-07: a Full Representation carries every field the Service holds; the Terse one omits
    // the fields `terseOffering` does not summarize.
    expect(items(full)[0]).toMatchObject({
      attributes: { size: 1 },
      schema: { url: "/schemas/a.json" }
    });
    expect(items(full)[0]).toHaveProperty("actions");
    const summary = await body(await odp.fetch(get("https://example.com/odp/offerings")));
    expect(items(summary)[0]).not.toHaveProperty("attributes");
    expect(items(summary)[0]).not.toHaveProperty("actions");
    expect((await odp.fetch(get("https://example.com/odp/collections/missing"))).status).toBe(404);
    expect(
      (await odp.fetch(get("https://example.com/odp/collections/missing/offerings"))).status
    ).toBe(404);
  });

  it("binds a continuation to the operation, limit and representation that produced it", async () => {
    const odp = serviceOf(createStaticCatalog({ collections, offerings: classified }));
    const first = await body(await odp.fetch(get("https://example.com/odp/offerings?limit=1")));
    const next = String(first["next"]);
    const cursor = new URL(next, "https://example.com").searchParams.get("cursor") ?? "";

    expect((await odp.fetch(get(`https://example.com${next}`))).status).toBe(200);
    // A cursor lifted onto another operation, page size or representation is not a valid cursor.
    for (const forged of [
      `/odp/offerings?cursor=${encodeURIComponent(cursor)}&limit=2`,
      `/odp/offerings?cursor=${encodeURIComponent(cursor)}&limit=1&representation=full`,
      `/odp/collections?cursor=${encodeURIComponent(cursor)}&limit=1`
    ])
      expect((await odp.fetch(get(`https://example.com${forged}`))).status, forged).toBe(400);
  });

  it("expires a continuation an hour after it was issued", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const odp = serviceOf(createStaticCatalog({ offerings }));
    const first = await body(await odp.fetch(get("https://example.com/odp/offerings?limit=1")));
    const next = `https://example.com${String(first["next"])}`;
    // PAG-19 is a minimum: the link MUST still work an hour after it was issued.
    vi.setSystemTime(new Date("2026-01-01T00:59:59Z"));
    const usable = await odp.fetch(get(next));
    expect(usable.status).toBe(200);
    expect(items(await body(usable))[0]?.["id"]).toBe("b");
    vi.setSystemTime(new Date("2026-01-01T01:00:01Z"));
    const expired = await odp.fetch(get(next));
    expect(expired.status).toBe(410);
    await expect(expired.json()).resolves.toMatchObject({ code: "CONTINUATION_EXPIRED" });
  });

  it("keeps continuations usable across processes when given a stable signing key", async () => {
    const continuationKey = "a-stable-secret-of-at-least-32-bytes";
    const first = serviceOf(createStaticCatalog({ continuationKey, offerings }));
    const second = serviceOf(createStaticCatalog({ continuationKey, offerings }));
    const page = await body(await first.fetch(get("https://example.com/odp/offerings?limit=1")));
    // Without a supplied key each catalog signs with its own random key, which confines every
    // cursor to that one instance.
    const continued = await second.fetch(get(`https://example.com${String(page["next"])}`));
    expect(continued.status).toBe(200);
    expect(items(await body(continued))[0]?.["id"]).toBe("b");

    const other = serviceOf(createStaticCatalog({ continuationKey: "b".repeat(32), offerings }));
    expect((await other.fetch(get(`https://example.com${String(page["next"])}`))).status).toBe(410);
  });

  it("refuses signing material too short to be a key", () => {
    expect(() => createStaticCatalog({ continuationKey: "too-short", offerings })).toThrow(
      "at least 32 bytes"
    );
    expect(() =>
      createStaticCatalog({ continuationKey: new Uint8Array(32), offerings })
    ).not.toThrow();
  });

  it("summarizes every field a Terse Representation may carry", async () => {
    const shared = {
      description: "Described",
      images: [
        { src: "/a.png", type: "image/png" as const },
        { src: "/b.png", type: "image/png" as const }
      ],
      language: "en",
      localizations: ["en"],
      web_url: "https://example.com/browse",
      auth_expands: true as const
    };
    const odp = serviceOf(
      createStaticCatalog({
        collections: [{ odp_version: "1.0", id: "plants", name: "Plants", ...shared }],
        offerings: [
          {
            odp_version: "1.0",
            id: "fern",
            name: "Fern",
            collection_ids: ["plants"],
            price: { type: "fixed", amount: "9.99", currency: "USD" },
            ...shared
          }
        ]
      })
    );
    const offering = items(
      await body(await odp.fetch(get("https://example.com/odp/offerings")))
    )[0];
    // REP-27: the primary image is the only summary behaviour `images` defines.
    expect(offering).toMatchObject({
      auth_expands: true,
      collection_ids: ["plants"],
      description: "Described",
      images: [{ src: "/a.png", type: "image/png" }],
      language: "en",
      localizations: ["en"],
      price: { type: "fixed", amount: "9.99", currency: "USD" },
      web_url: "https://example.com/browse"
    });
    const collection = items(
      await body(await odp.fetch(get("https://example.com/odp/collections")))
    )[0];
    expect(collection).toMatchObject({
      auth_expands: true,
      description: "Described",
      images: [{ src: "/a.png", type: "image/png" }],
      web_url: "https://example.com/browse"
    });
  });

  it("rejects a Collection hierarchy deeper than the protocol allows", () => {
    const deep = Array.from({ length: 34 }, (_value, index) => ({
      odp_version: "1.0" as const,
      id: `level-${String(index)}`,
      name: `Level ${String(index)}`,
      ...(index === 0 ? {} : { parent_ids: [`level-${String(index - 1)}`] })
    }));
    expect(() => createStaticCatalog({ collections: deep, offerings: [] })).toThrow("32 edges");
  });

  it("rejects duplicate identifiers and over-deep hierarchies", () => {
    expect(() => createStaticCatalog({ offerings: [first, { ...first, name: "Again" }] })).toThrow(
      "identifiers must be unique"
    );
    expect(() =>
      createStaticCatalog({
        collections: [
          { odp_version: "1.0", id: "a", name: "A" },
          { odp_version: "1.0", id: "b", name: "B", parent_ids: ["missing"] }
        ],
        offerings: []
      })
    ).toThrow("unknown parent");
    // COL-20: naming itself as a parent is the shortest cycle, not a special case.
    expect(() =>
      createStaticCatalog({
        collections: [{ odp_version: "1.0", id: "a", name: "A", parent_ids: ["a"] }],
        offerings: []
      })
    ).toThrow("acyclic");
  });

  it("rejects a cursor that is not a signed continuation at all", async () => {
    const odp = serviceOf(createStaticCatalog({ offerings }));
    for (const cursor of ["opaque", "a.b.c", "YQ.YQ"])
      expect(
        (await odp.fetch(get(`https://example.com/odp/offerings?cursor=${cursor}`))).status,
        cursor
      ).toBe(410);
  });

  it("keeps everything but traversal position out of the cursor", async () => {
    const odp = serviceOf(createStaticCatalog({ offerings }));
    const page = await body(await odp.fetch(get("https://example.com/odp/offerings?limit=1")));
    const cursor = new URL(String(page["next"]), "https://example.com").searchParams.get("cursor");
    const [payload] = String(cursor).split(".");
    const state: unknown = JSON.parse(Buffer.from(String(payload), "base64url").toString("utf8"));
    // PAG-24: a self-contained cursor travels through the caller, so it carries no credential,
    // access-policy detail or private catalog data — only where the traversal had reached.
    expect(Object.keys(state as Record<string, unknown>).sort()).toEqual([
      "expiresAt",
      "limit",
      "offset",
      "representation",
      "target"
    ]);
  });

  it("rejects a correctly signed cursor whose payload is not continuation state", async () => {
    const continuationKey = "a-stable-secret-of-at-least-32-bytes";
    const odp = serviceOf(createStaticCatalog({ continuationKey, offerings }));
    const sign = (state: string): string => {
      const payload = Buffer.from(state, "utf8").toString("base64url");
      return `${payload}.${createHmac("sha256", continuationKey).update(payload).digest("base64url")}`;
    };
    // A valid signature proves only that this Service minted the bytes, never what they mean.
    const forged = [
      sign("not json at all"),
      sign("[]"),
      sign('{"offset":1}'),
      sign(
        `{"expiresAt":${String(Date.now() + 3_600_000)},"limit":1,"offset":0,"target":"x","representation":"partial"}`
      )
    ];
    for (const cursor of forged)
      expect(
        (
          await odp.fetch(
            get(`https://example.com/odp/offerings?cursor=${encodeURIComponent(cursor)}`)
          )
        ).status,
        cursor
      ).toBe(410);
  });
});

describe("Negotiation edge cases", () => {
  it("treats `*` as the residual it is, never as a peer of a named range", async () => {
    const odp = serviceOf(EMPTY, MULTILINGUAL);
    const language = async (header: string): Promise<string | null> =>
      (
        await odp.fetch(get("https://example.com/odp/offerings", { "accept-language": header }))
      ).headers.get("content-language");

    // RFC 9110 §12.5.4: `*` matches only the tags no other range in the field matched.
    expect(await language("*, fr-CA")).toBe("fr-CA");
    expect(await language("*;q=1, fr-CA;q=0.1")).toBe("fr-CA");
    expect(await language("*;q=0, fr-CA")).toBe("fr-CA");
    // A `q=0` range carves its tags out of the residual rather than being merely outranked.
    expect(await language("en;q=0, *")).toBe("fr-CA");
    expect(await language("en;q=0, fr-CA;q=0, de-DE;q=0, *")).toBe("en");
  });

  it("excludes every tag a refused range prefixes", () => {
    // RFC 4647 basic filtering: `en;q=0` refuses `en-GB` as well as `en`.
    expect(selectLanguage("en;q=0, *", "en-GB", ["en-GB", "fr-CA"])).toBe("fr-CA");
    expect(selectLanguage("fr;q=0, *", "en", ["en", "fr-CA"])).toBe("en");
  });

  it("refuses a media range whose quality is zero or unreadable", async () => {
    const odp = serviceOf(EMPTY);
    const status = async (accept: string): Promise<number> =>
      (await odp.fetch(get("https://example.com/odp/offerings", { accept }))).status;
    expect(await status("*/*;q=..")).toBe(406);
    expect(await status("application/odp+json;q=1.5")).toBe(406);
    expect(await status("application/odp+json;q=0.001")).toBe(200);
    expect(await status("application/odp+json;charset=utf-8")).toBe(200);
  });
});

describe("Search request parameters", () => {
  const searchable = {
    ...EMPTY,
    searchOfferings: vi.fn(() => ({ odp_version: "1.0" as const, items: [] })),
    searchCollections: vi.fn(() => ({ odp_version: "1.0" as const, items: [] }))
  };

  function post(path: string, value: Record<string, unknown>): Request {
    return new Request(`https://example.com${path}`, {
      method: "POST",
      headers: { "content-type": "application/odp+json" },
      body: JSON.stringify({ odp_version: "1.0", ...value })
    });
  }

  it("takes a POST search page size from the body, never from the query string", async () => {
    const searchOfferings = vi.fn(() => ({ odp_version: "1.0" as const, items: [] }));
    const odp = serviceOf({ ...EMPTY, searchOfferings });
    await odp.fetch(post("/odp/offerings/search", { query: "x", limit: 5 }));
    expect(searchOfferings).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5 }),
      expect.objectContaining({ limit: 5, representation: "terse" })
    );
    // PAG-13 places `limit` in the request body for a POST search, so the query string has no
    // meaning here and is refused rather than silently changing the page size.
    const misplaced = await odp.fetch(post("/odp/offerings/search?limit=10", { query: "x" }));
    expect(misplaced.status).toBe(400);
    await expect(misplaced.json()).resolves.toMatchObject({ code: "INVALID_REQUEST" });
    expect(searchOfferings).toHaveBeenCalledTimes(1);
  });

  it("passes a Collection search body through to its handler", async () => {
    const searchCollections = vi.fn(() => ({ odp_version: "1.0" as const, items: [] }));
    const odp = serviceOf({ ...EMPTY, searchCollections });
    await odp.fetch(post("/odp/collections/search", { query: "plants", limit: 7 }));
    expect(searchCollections).toHaveBeenCalledWith(
      expect.objectContaining({ query: "plants" }),
      expect.objectContaining({ limit: 7, representation: "terse" })
    );
  });

  it("carries the requested representation onto a search continuation", async () => {
    const searchOfferings = vi.fn(() => ({ odp_version: "1.0" as const, items: [] }));
    const odp = serviceOf({ ...EMPTY, searchOfferings });
    await odp.fetch(
      get("https://example.com/odp/offerings/search?cursor=opaque&representation=full")
    );
    expect(searchOfferings).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ cursor: "opaque", representation: "full" })
    );
  });

  it("keeps the search handlers reachable through both entry points", async () => {
    const odp = serviceOf(searchable);
    expect((await odp.fetch(post("/odp/offerings/search", { query: "x" }))).status).toBe(200);
    expect((await odp.fetch(post("/odp/collections/search", { query: "x" }))).status).toBe(200);
  });
});

describe("Rejected catalog output", () => {
  /** The failure an operator sees, which is the only thing that distinguishes one 500 from another. */
  async function faultOf(
    catalog: OdpCatalog,
    request: Request
  ): Promise<{ message: string; status: number }> {
    let captured: unknown;
    const odp = serviceOf(catalog, BASE, (error) => {
      captured = error;
    });
    const response = await odp.fetch(request);
    return {
      message: captured instanceof Error ? captured.message : String(captured),
      status: response.status
    };
  }

  const listing = (page: Record<string, unknown>): OdpCatalog => ({
    ...EMPTY,
    listOfferings: () => malformedPage(page)
  });
  const offerings = get("https://example.com/odp/offerings");

  it("names the envelope rule a rejected page broke", async () => {
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["non-array items", { odp_version: "1.0", items: {} }, /items array/u],
      [
        "too many items",
        {
          odp_version: "1.0",
          items: Array.from({ length: 101 }, (_value, index) => ({
            id: `o${String(index)}`,
            name: "O"
          }))
        },
        /more than 100 items/u
      ],
      ["numeric next", { odp_version: "1.0", items: [], next: 7 }, /non-empty string/u],
      ["empty next", { odp_version: "1.0", items: [], next: "" }, /non-empty string/u],
      [
        "over-long next",
        { odp_version: "1.0", items: [], next: `/odp/offerings?cursor=${"a".repeat(2100)}` },
        /length limit/u
      ],
      [
        "non-ASCII next",
        { odp_version: "1.0", items: [], next: "/odp/offerings?c=café" },
        /ASCII/u
      ],
      ["unparseable next", { odp_version: "1.0", items: [], next: "http://[" }, /valid reference/u],
      [
        "cross-origin next",
        { odp_version: "1.0", items: [], next: "https://evil.example/odp/offerings" },
        /Service origin/u
      ],
      [
        "self-referencing next",
        { odp_version: "1.0", items: [], next: "/odp/offerings" },
        /advance past this request/u
      ],
      [
        "prohibited auth_expands",
        { odp_version: "1.0", items: [], auth_expands: false },
        /Invalid ODP/u
      ]
    ];
    for (const [label, page, message] of cases) {
      const fault = await faultOf(listing(page), offerings);
      expect(fault.status, label).toBe(500);
      expect(fault.message, label).toMatch(message);
    }
  });

  it("accepts a continuation reference at the length limit and refuses the byte past it", async () => {
    const prefix = "/odp/offerings?cursor=";
    const atLimit = prefix + "a".repeat(2048 - prefix.length);
    expect(
      (await faultOf(listing({ odp_version: "1.0", items: [], next: atLimit }), offerings)).status
    ).toBe(200);
    const overLimit = `${atLimit}a`;
    expect(
      (await faultOf(listing({ odp_version: "1.0", items: [], next: overLimit }), offerings)).status
    ).toBe(500);
  });

  it("accepts a document at its byte limit and refuses the byte past it", async () => {
    const shell = JSON.stringify({
      odp_version: "1.0",
      id: "big",
      name: "Big",
      schema: { url: "/s.json" },
      attributes: { blob: "" }
    });
    const offering = (blob: string): OdpCatalog => ({
      ...EMPTY,
      getOffering: (id) => ({
        odp_version: "1.0" as const,
        id,
        name: "Big",
        schema: { url: "/s.json" },
        attributes: { blob }
      })
    });
    const request = get("https://example.com/odp/offerings/big");
    const fill = "x".repeat(524_288 - shell.length);
    expect((await faultOf(offering(fill), request)).status).toBe(200);
    const over = await faultOf(offering(`${fill}x`), request);
    expect(over.status).toBe(500);
    expect(over.message).toMatch(/524288/u);
  });

  it("accepts a document at its nesting-depth limit and refuses the level past it", async () => {
    const nested = (levels: number): OdpCatalog => {
      let attributes: Record<string, unknown> = { leaf: 1 };
      for (let index = 0; index < levels; index += 1) attributes = { child: attributes };
      return {
        ...EMPTY,
        getOffering: (id) => ({
          odp_version: "1.0" as const,
          id,
          name: "Deep",
          schema: { url: "/s.json" },
          attributes
        })
      };
    };
    const request = get("https://example.com/odp/offerings/deep");
    // The document itself is one level, `attributes` the second, so fourteen wrappers reach 16.
    expect((await faultOf(nested(14), request)).status).toBe(200);
    const over = await faultOf(nested(15), request);
    expect(over.status).toBe(500);
    expect(over.message).toMatch(/nesting-depth/u);
  });

  it("distinguishes a representation rule from the fixture that carries it", async () => {
    const withActions: OdpCatalog = {
      ...EMPTY,
      getOffering: (id) => ({
        odp_version: "1.0" as const,
        id,
        name: "Widget",
        actions: [
          {
            authentication: "required" as const,
            id: "rent",
            rel: "purchase",
            http: { href: "/rent", method: "POST" as const }
          }
        ]
      })
    };
    const odp = serviceOf(withActions);
    expect(
      (await odp.fetch(get("https://example.com/odp/offerings/widget?representation=full"))).status
    ).toBe(200);
    const terse = await faultOf(
      withActions,
      get("https://example.com/odp/offerings/widget?representation=terse")
    );
    expect(terse.status).toBe(500);
    expect(terse.message).toMatch(/Terse Offering cannot contain Actions/u);

    const detailed: OdpCatalog = {
      ...EMPTY,
      getCollection: (id) => ({
        odp_version: "1.0" as const,
        id,
        name: "Plants",
        detail_fields: ["/description"]
      })
    };
    expect(
      (
        await serviceOf(detailed).fetch(
          get("https://example.com/odp/collections/plants?representation=terse")
        )
      ).status
    ).toBe(200);
    const full = await faultOf(detailed, get("https://example.com/odp/collections/plants"));
    expect(full.status).toBe(500);
    expect(full.message).toMatch(/Full Collection cannot contain detail_fields/u);
  });

  it("refuses a refinement group the request did not ask for, repeated, or on a continuation", async () => {
    const group = (id: string) => ({ filter_id: id, values: [{ value: "red", count: 3 }] });
    const search = (refinements: ReturnType<typeof group>[]): OdpCatalog => ({
      ...EMPTY,
      searchOfferings: () => ({ odp_version: "1.0" as const, items: [], refinements })
    });
    const post = (value: Record<string, unknown>, query = ""): Request =>
      new Request(`https://example.com/odp/offerings/search${query}`, {
        method: "POST",
        headers: { "content-type": "application/odp+json" },
        body: JSON.stringify({ odp_version: "1.0", query: "x", ...value })
      });

    expect(
      (await serviceOf(search([group("color")])).fetch(post({ refinements: ["color"] }))).status
    ).toBe(200);
    // FLT-30: one group per requested filter, and no group for a filter that was not requested.
    const repeated = await faultOf(
      search([group("color"), group("color")]),
      post({ refinements: ["color"] })
    );
    expect(repeated.message).toMatch(/color more than once/u);
    const unrequested = await faultOf(search([group("color")]), post({ refinements: ["size"] }));
    expect(unrequested.message).toMatch(/color that was not requested/u);
    // OFR-15: a continuation carries no refinements even when the request asked for them.
    const continued = await faultOf(
      search([group("color")]),
      post({ refinements: ["color"] }, "?cursor=opaque")
    );
    expect(continued.message).toMatch(/continuation cannot contain refinements/u);
  });

  it("reports a rejected promise from a catalog as a Service fault", async () => {
    const failure = new Error("database unreachable");
    const fault = await faultOf(
      { ...EMPTY, listOfferings: () => Promise.reject(failure) },
      offerings
    );
    expect(fault.status).toBe(500);
    expect(fault.message).toBe("database unreachable");
    // An intentional Problem Details keeps its status when it arrives as a rejection.
    const refused = serviceOf({
      ...EMPTY,
      listOfferings: () => Promise.reject(new OdpServiceError(403, "NOT_AUTHORIZED", "No"))
    });
    expect((await refused.fetch(offerings)).status).toBe(403);
  });

  it("answers even when the operator's own error hook throws", async () => {
    const odp = serviceOf(
      {
        ...EMPTY,
        listOfferings: () => {
          throw new Error("catalog down");
        }
      },
      BASE,
      () => {
        throw new Error("logger down");
      }
    );
    const response = await odp.fetch(offerings);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("drops handler headers when it has to normalize the status they came with", async () => {
    const odp = serviceOf({
      ...EMPTY,
      listOfferings: () => {
        throw new OdpServiceError(200, "TEAPOT", "Not an error", { "retry-after": "30" });
      }
    });
    const response = await odp.fetch(offerings);
    // The headers described a response this Service is not sending, so they do not travel with it.
    expect(response.status).toBe(500);
    expect(response.headers.get("retry-after")).toBeNull();
  });
});

describe("Cursor validation", () => {
  const offerings = [
    { odp_version: "1.0" as const, id: "a", name: "A" },
    { odp_version: "1.0" as const, id: "b", name: "B" }
  ];
  const continuationKey = "a-stable-secret-of-at-least-32-bytes";

  function forge(state: Record<string, unknown>): string {
    const payload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
    const signature = createHmac("sha256", continuationKey).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  it("refuses a signed cursor whose position this Service cannot serve", async () => {
    const odp = serviceOf(createStaticCatalog({ continuationKey, offerings }));
    const base = {
      expiresAt: Date.now() + 3_600_000,
      limit: 1,
      offset: 1,
      representation: "terse",
      target: "https://example.com/odp/offerings"
    };
    expect(
      (
        await odp.fetch(
          get(`https://example.com/odp/offerings?limit=1&cursor=${encodeURIComponent(forge(base))}`)
        )
      ).status
    ).toBe(200);
    // PAG-26: a valid signature says this Service minted the bytes, not that they are usable. A
    // negative offset re-yields items the traversal has already passed.
    for (const [label, state] of [
      ["negative offset", { ...base, offset: -1 }],
      ["zero limit", { ...base, limit: 0 }],
      ["over-large limit", { ...base, limit: 101 }],
      ["fractional offset", { ...base, offset: 1.5 }]
    ] as [string, Record<string, unknown>][]) {
      const cursor = encodeURIComponent(forge(state));
      const response = await odp.fetch(
        get(`https://example.com/odp/offerings?limit=1&cursor=${cursor}`)
      );
      expect(response.status, label).toBe(410);
    }
  });

  it("does not let a caller's later mutation of the signing key invalidate live cursors", async () => {
    const key = new Uint8Array(32).fill(7);
    const odp = serviceOf(createStaticCatalog({ continuationKey: key, offerings }));
    const page = await body(await odp.fetch(get("https://example.com/odp/offerings?limit=1")));
    key.fill(9);
    expect((await odp.fetch(get(`https://example.com${String(page["next"])}`))).status).toBe(200);
  });
});
