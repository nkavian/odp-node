import { Buffer } from "node:buffer";

import $RefParser, { type FileInfo } from "@apidevtools/json-schema-ref-parser";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

import { resolveResourceReference } from "@offering-protocol/core";

import type { OdpCache } from "./cache.js";
import { requestSupportingJson, type OdpTransport } from "./transport.js";

const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const MAXIMUM_DOCUMENTS = 16;
const MAXIMUM_DEPTH = 8;
const MAXIMUM_GRAPH_BYTES = 1_048_576;
const STANDARD_VOCABULARY = "https://json-schema.org/draft/2020-12/vocab/";

export type JsonSchema = boolean | Record<string, unknown>;

export interface SchemaResolutionOptions {
  url: URL;
  transport: OdpTransport;
  cache?: OdpCache;
  signal?: AbortSignal;
}

export interface ResolvedSchema {
  schema: JsonSchema;
  validate(value: unknown): boolean;
}

export async function resolveSchema(options: SchemaResolutionOptions): Promise<ResolvedSchema> {
  const root = requireSchema(await retrieve(options.url));
  const depths = new Map([[withoutFragment(String(options.url)), 0]]);
  let documents = 1;
  let graphBytes = encodedLength(root);
  const bundled = await $RefParser.bundle(String(options.url), root, {
    parse: { binary: false, text: false, yaml: false },
    resolve: {
      file: false,
      http: false,
      odp: {
        order: 1,
        canRead: /^https?:\/\//u,
        async read(file: FileInfo) {
          documents += 1;
          if (documents > MAXIMUM_DOCUMENTS)
            throw new RangeError("ODP Attribute Schema graph exceeds 16 documents");
          const parent = withoutFragment(file.baseUrl ?? String(options.url));
          const depth = (depths.get(parent) ?? 0) + 1;
          if (depth > MAXIMUM_DEPTH)
            throw new RangeError("ODP Attribute Schema graph exceeds eight reference levels");
          const url = resolveResourceReference(file.url, options.url.origin);
          depths.set(withoutFragment(String(url)), depth);
          const schema = requireSchema(await retrieve(url));
          graphBytes += encodedLength(schema);
          if (graphBytes > MAXIMUM_GRAPH_BYTES)
            throw new RangeError("ODP Attribute Schema graph exceeds its byte limit");
          return schema;
        }
      }
    },
    timeoutMs: 30_000
  });
  const schema = requireSchema(bundled);
  requireSupportedVocabularies(schema);
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateSchema: true });
  addFormatsModule.default(ajv);
  const validator = ajv.compile(schema);
  return { schema: structuredClone(schema), validate: (value) => validator(value) };

  function retrieve(url: URL): Promise<unknown> {
    return requestSupportingJson({
      transport: options.transport,
      url,
      ...(options.cache === undefined ? {} : { cache: options.cache }),
      cachePartition: "anonymous",
      resourceClass: "attribute-schema",
      fallbackTtlMs: 86_400_000,
      accept: "application/schema+json",
      mediaTypes: ["application/schema+json"],
      maximumBytes: 262_144,
      validate: requireSchema,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
  }
}

function requireSchema(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("ODP Attribute Schema must be a JSON object");
  const schema = value as Record<string, unknown>;
  if (schema["$schema"] !== DIALECT)
    throw new TypeError("ODP Attribute Schema must declare JSON Schema Draft 2020-12");
  return schema;
}

function requireSupportedVocabularies(schema: JsonSchema): void {
  const pending: unknown[] = [schema];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value as unknown[]) pending.push(item);
      continue;
    }
    const object = value as Record<string, unknown>;
    const vocabulary = object["$vocabulary"];
    if (typeof vocabulary === "object" && vocabulary !== null && !Array.isArray(vocabulary)) {
      for (const [uri, required] of Object.entries(vocabulary))
        if (required === true && !uri.startsWith(STANDARD_VOCABULARY))
          throw new TypeError(`ODP Attribute Schema requires unsupported vocabulary ${uri}`);
    }
    pending.push(...Object.values(object));
  }
}

function encodedLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function withoutFragment(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return String(url);
}
