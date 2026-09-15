import { describe, expect, it, vi } from "vitest";

import { createInMemoryOdpCache } from "../../src/cache.js";
import { resolveSchema } from "../../src/schemas.js";
import type { OdpTransport } from "../../src/transport.js";

const DIALECT = "https://json-schema.org/draft/2020-12/schema";

function schemaResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/schema+json" }
  });
}

/** Serves a fixed map of schema documents and counts what was actually requested. */
function serve(documents: Record<string, unknown>): {
  transport: OdpTransport;
  requested: string[];
} {
  const requested: string[] = [];
  const transport: OdpTransport = vi.fn((url: URL) => {
    requested.push(String(url));
    const document = documents[String(url)];
    if (document === undefined) return Promise.resolve(new Response(null, { status: 404 }));
    return Promise.resolve(schemaResponse(document));
  });
  return { transport, requested };
}

function resolve(documents: Record<string, unknown>, root = "https://schemas.example/root.json") {
  const { transport, requested } = serve(documents);
  return {
    requested,
    result: resolveSchema({ url: new URL(root), transport, cache: createInMemoryOdpCache() })
  };
}

describe("Attribute Schema retrieval", () => {
  it("resolves a schema and validates an instance against it", async () => {
    const { result } = resolve({
      "https://schemas.example/root.json": {
        $schema: DIALECT,
        type: "object",
        properties: { size: { type: "integer" } },
        required: ["size"]
      }
    });
    const resolved = await result;
    expect(resolved.validate({ size: 2 })).toBe(true);
    expect(resolved.validate({ size: "two" })).toBe(false);
  });

  it("rejects a document that is not an object or does not declare Draft 2020-12", async () => {
    await expect(resolve({ "https://schemas.example/root.json": [] }).result).rejects.toThrow(
      "must be a JSON object"
    );
    await expect(
      resolve({
        "https://schemas.example/root.json": { $schema: "http://json-schema.org/draft-07/schema#" }
      }).result
    ).rejects.toThrow("Draft 2020-12");
  });

  it("rejects a dynamic reference that is not fragment-only", async () => {
    await expect(
      resolve({
        "https://schemas.example/root.json": {
          $schema: DIALECT,
          properties: { node: { $dynamicRef: "https://schemas.example/other.json#node" } }
        }
      }).result
    ).rejects.toThrow("fragment-only");
  });

  it("rejects a schema that requires a vocabulary outside the standard set", async () => {
    await expect(
      resolve({
        "https://schemas.example/root.json": {
          $schema: DIALECT,
          $vocabulary: { "https://vendor.example/vocab/custom": true }
        }
      }).result
    ).rejects.toThrow("unsupported vocabulary");
  });

  it("allows standard and optional extension vocabularies", async () => {
    await expect(
      resolve({
        "https://schemas.example/root.json": {
          $schema: DIALECT,
          $vocabulary: {
            "https://json-schema.org/draft/2020-12/vocab/core": true,
            "https://vendor.example/vocab/optional": false
          }
        }
      }).result
    ).resolves.toBeDefined();
  });

  it("counts each referenced document once however many references point at it", async () => {
    const leaf = { $schema: DIALECT, type: "string" };
    const { result, requested } = resolve({
      "https://schemas.example/root.json": {
        $schema: DIALECT,
        type: "object",
        properties: {
          a: { $ref: "https://schemas.example/leaf.json" },
          b: { $ref: "https://schemas.example/leaf.json" }
        }
      },
      "https://schemas.example/leaf.json": leaf
    });
    await expect(result).resolves.toBeDefined();
    expect(requested.filter((url) => url.endsWith("leaf.json")).length).toBeLessThanOrEqual(2);
  });

  it("rejects a reference graph wider than sixteen documents", async () => {
    const documents: Record<string, unknown> = {};
    const properties: Record<string, unknown> = {};
    for (let index = 0; index < 20; index += 1) {
      const url = `https://schemas.example/leaf-${String(index)}.json`;
      documents[url] = { $schema: DIALECT, type: "string" };
      properties[`p${String(index)}`] = { $ref: url };
    }
    documents["https://schemas.example/root.json"] = {
      $schema: DIALECT,
      type: "object",
      properties
    };
    await expect(resolve(documents).result).rejects.toThrow("16 documents");
  });

  it("rejects a reference chain deeper than eight levels", async () => {
    const documents: Record<string, unknown> = {};
    for (let index = 0; index < 12; index += 1) {
      const next = `https://schemas.example/level-${String(index + 1)}.json`;
      documents[`https://schemas.example/level-${String(index)}.json`] = {
        $schema: DIALECT,
        // Each document declares an `$id`, which is what made the depth counter reset to zero:
        // the resolution base then points at the `$id` scope rather than the document URL.
        $id: `https://schemas.example/level-${String(index)}.json`,
        type: "object",
        properties: { next: { $ref: next } }
      };
    }
    documents["https://schemas.example/level-12.json"] = { $schema: DIALECT, type: "string" };
    await expect(resolve(documents, "https://schemas.example/level-0.json").result).rejects.toThrow(
      /reference levels|16 documents/u
    );
  });

  it("rejects a graph whose combined size exceeds its byte budget", async () => {
    const filler = "x".repeat(200_000);
    const documents: Record<string, unknown> = {
      "https://schemas.example/root.json": {
        $schema: DIALECT,
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 8 }, (_value, index) => [
            `p${String(index)}`,
            { $ref: `https://schemas.example/big-${String(index)}.json` }
          ])
        )
      }
    };
    for (let index = 0; index < 8; index += 1)
      documents[`https://schemas.example/big-${String(index)}.json`] = {
        $schema: DIALECT,
        description: filler,
        type: "string"
      };
    await expect(resolve(documents).result).rejects.toThrow(/byte limit/u);
  });

  it("rejects a regular expression whose shape admits catastrophic backtracking", async () => {
    await expect(
      resolve({
        "https://schemas.example/root.json": {
          $schema: DIALECT,
          type: "object",
          properties: { code: { type: "string", pattern: "^(a+)+$" } }
        }
      }).result
    ).rejects.toThrow("nested unbounded quantifier");
  });

  it("rejects a nested quantifier declared through patternProperties", async () => {
    await expect(
      resolve({
        "https://schemas.example/root.json": {
          $schema: DIALECT,
          type: "object",
          patternProperties: { "^(x*)*$": { type: "string" } }
        }
      }).result
    ).rejects.toThrow("nested unbounded quantifier");
  });

  it("rejects an over-long regular expression", async () => {
    await expect(
      resolve({
        "https://schemas.example/root.json": {
          $schema: DIALECT,
          type: "object",
          properties: { code: { type: "string", pattern: `^${"a".repeat(1_200)}$` } }
        }
      }).result
    ).rejects.toThrow("length limit");
  });

  it("accepts ordinary patterns, including a quantified group with no inner quantifier", async () => {
    const resolved = await resolve({
      "https://schemas.example/root.json": {
        $schema: DIALECT,
        type: "object",
        properties: {
          slug: { type: "string", pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" },
          code: { type: "string", pattern: "^(ab)+$" },
          date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          set: { type: "string", pattern: "^[a-z*+]{1,8}$" }
        }
      }
    }).result;
    expect(
      resolved.validate({ slug: "one-two", code: "abab", date: "2026-01-01", set: "a*" })
    ).toBe(true);
  });
  it("looks through wrapping and non-capturing groups to find a nested quantifier", async () => {
    for (const pattern of [
      "^((a+))+$",
      "^(?:(?:x*))*$",
      "^(a+|b)+$",
      "^(\\d+)*$",
      "^([0-9]{2,})+$"
    ])
      await expect(
        resolve({
          "https://schemas.example/root.json": {
            $schema: DIALECT,
            type: "object",
            properties: { value: { type: "string", pattern } }
          }
        }).result
      ).rejects.toThrow("nested unbounded quantifier");
  });

  it("allows quantified groups whose branches each carry a literal anchor", async () => {
    for (const pattern of [
      "^(a|b)+$",
      "^((a\\+)+)+$",
      "^(-a+)*$",
      "^(?:ab|cd)+$",
      "^([a-z]+\\.)+[a-z]{2}$",
      "^(a\\+)+$",
      "^[(*+)]+$"
    ])
      await expect(
        resolve({
          "https://schemas.example/root.json": {
            $schema: DIALECT,
            type: "object",
            properties: { value: { type: "string", pattern } }
          }
        }).result
      ).resolves.toBeDefined();
  });

  it("rejects a malformed expression with unbalanced groups", async () => {
    await expect(
      resolve({
        "https://schemas.example/root.json": {
          $schema: DIALECT,
          type: "string",
          pattern: "^(()))+$"
        }
      }).result
    ).rejects.toThrow();
  });

  it("ignores an unbalanced parenthesis rather than mis-parsing the pattern", async () => {
    const resolved = await resolve({
      "https://schemas.example/root.json": {
        $schema: DIALECT,
        type: "object",
        properties: { value: { type: "string", pattern: "^a\\)b$" } }
      }
    }).result;
    expect(resolved.validate({ value: "a)b" })).toBe(true);
  });

  it("reuses a cached schema document across resolutions", async () => {
    const documents = {
      "https://schemas.example/root.json": {
        $schema: DIALECT,
        type: "object",
        properties: { size: { type: "integer" } }
      }
    };
    const requested: string[] = [];
    const transport: OdpTransport = vi.fn((url: URL) => {
      requested.push(String(url));
      return Promise.resolve(
        new Response(JSON.stringify(documents["https://schemas.example/root.json"]), {
          headers: {
            "content-type": "application/schema+json",
            "cache-control": "max-age=86400"
          }
        })
      );
    });
    const cache = createInMemoryOdpCache();
    const url = new URL("https://schemas.example/root.json");
    await resolveSchema({ url, transport, cache });
    await resolveSchema({ url, transport, cache });
    expect(requested).toHaveLength(1);
  });

  it("propagates the caller's abort signal to schema retrieval", async () => {
    const controller = new AbortController();
    controller.abort();
    const transport: OdpTransport = vi.fn(() =>
      Promise.reject(new DOMException("aborted", "AbortError"))
    );
    await expect(
      resolveSchema({
        url: new URL("https://schemas.example/root.json"),
        transport,
        signal: controller.signal
      })
    ).rejects.toThrow();
  });

  it("tolerates a schema whose $id cannot be resolved to a URL", async () => {
    const resolved = await resolve({
      "https://schemas.example/root.json": {
        $schema: DIALECT,
        $id: "urn:example:root",
        type: "object",
        properties: { size: { type: "integer" } }
      }
    }).result;
    expect(resolved.validate({ size: 1 })).toBe(true);
  });
});
