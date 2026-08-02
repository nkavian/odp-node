import { validate } from "@hyperjump/json-schema/openapi-3-1";

import type { OdpCache } from "./cache.js";
import { requestSupportingJson, type OdpTransport } from "./transport.js";

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export interface OpenApiResolutionOptions {
  url: URL;
  operationId: string;
  transport: OdpTransport;
  cache?: OdpCache;
  signal?: AbortSignal;
}

export async function resolveOpenApiOperation(
  options: OpenApiResolutionOptions
): Promise<{ document: Record<string, unknown>; operation: Record<string, unknown> }> {
  const value = await requestSupportingJson({
    transport: options.transport,
    url: options.url,
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    cachePartition: "anonymous",
    resourceClass: "openapi",
    fallbackTtlMs: 0,
    accept: "application/vnd.oai.openapi+json;version=3.1, application/json;q=0.9",
    mediaTypes: ["application/vnd.oai.openapi+json", "application/json"],
    maximumBytes: 1_048_576,
    validate: (candidate) =>
      requireJsonObject(candidate, "ODP OpenAPI document must be a JSON object"),
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  const document = requireJsonObject(value, "ODP OpenAPI document must be a JSON object");
  if (
    typeof document["openapi"] !== "string" ||
    !/^3\.1\.\d+(?:[-+].*)?$/u.test(document["openapi"])
  )
    throw new TypeError("ODP Action requires an OpenAPI 3.1 document");
  const validation = await validate("https://spec.openapis.org/oas/3.1/schema-base", document);
  if (!validation.valid) throw new TypeError("ODP Action OpenAPI document is invalid");
  const matches: Record<string, unknown>[] = [];
  const paths = requireJsonObject(document["paths"], "ODP OpenAPI document must contain paths");
  for (const path of Object.values(paths)) {
    if (typeof path !== "object" || path === null || Array.isArray(path)) continue;
    const item = path as Record<string, unknown>;
    for (const method of METHODS) {
      const candidate = item[method];
      if (
        typeof candidate === "object" &&
        candidate !== null &&
        !Array.isArray(candidate) &&
        (candidate as Record<string, unknown>)["operationId"] === options.operationId
      )
        matches.push(candidate as Record<string, unknown>);
    }
  }
  if (matches.length !== 1)
    throw new TypeError(`ODP Action operation_id ${options.operationId} must resolve exactly once`);
  const operation = matches[0];
  if (operation === undefined) throw new TypeError("ODP Action OpenAPI operation is unavailable");
  return { document: structuredClone(document), operation: structuredClone(operation) };
}

function requireJsonObject(value: unknown, message: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(message);
  if (!isJson(value)) throw new TypeError(message);
  return value as JsonObject;
}

function isJson(value: unknown): value is Json {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJson);
  return typeof value === "object" && Object.values(value as Record<string, unknown>).every(isJson);
}
