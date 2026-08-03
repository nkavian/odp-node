import CachePolicy from "http-cache-semantics";

import {
  deriveServiceOrigin,
  parseServiceDocument,
  type EnrollmentProtocol,
  type OperationDescriptor,
  type PaymentProtocol,
  type ServiceDocument
} from "@offering-protocol/core";

import type { OdpCache, OdpCacheRecord } from "./cache.js";

const ODP_MEDIA_TYPE = "application/odp+json";
const ODP_WELL_KNOWN_PATH = "/.well-known/odp";
const SERVICE_DOCUMENT_MAX_BYTES = 65_536;
const SERVICE_DOCUMENT_MAX_DEPTH = 8;
const DEFAULT_FALLBACK_TTL_MS = 4 * 60 * 60 * 1000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface OdpServiceCapabilities {
  enrollment: EnrollmentProtocol[];
  operations: OperationDescriptor[];
  payments: PaymentProtocol[];
}

export interface ServiceInspection {
  document: ServiceDocument;
  requestedUrl: URL;
  finalUrl: URL;
  serviceOrigin: string;
  freshness: "fresh" | "revalidated" | "fetched";
  capabilities: OdpServiceCapabilities;
}

export interface InspectServiceOptions {
  serviceUrl: string | URL;
  acceptLanguage?: string;
  cache?: OdpCache;
  fallbackTtlMs?: number;
  fetch?: typeof fetch;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export type OdpInspectionErrorCode =
  | "aborted"
  | "http_error"
  | "invalid_json"
  | "invalid_media_type"
  | "invalid_redirect"
  | "response_too_large"
  | "validation_failed";

export class OdpInspectionError extends Error {
  readonly code: OdpInspectionErrorCode;
  readonly status?: number;

  constructor(message: string, code: OdpInspectionErrorCode, status?: number) {
    super(message);
    this.name = "OdpInspectionError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

const flights = new WeakMap<OdpCache, Map<string, Promise<ServiceInspection>>>();

export async function inspectService(options: InspectServiceOptions): Promise<ServiceInspection> {
  const serviceOrigin = deriveServiceOrigin(options.serviceUrl);
  const requestedUrl = new URL(ODP_WELL_KNOWN_PATH, serviceOrigin);
  const cache = options.cache;
  if (cache === undefined || options.signal !== undefined)
    return fetchInspection(options, requestedUrl, serviceOrigin);

  const key = `${String(requestedUrl)}\u0000${options.acceptLanguage ?? ""}`;
  const active = flights.get(cache) ?? new Map<string, Promise<ServiceInspection>>();
  flights.set(cache, active);
  const existing = active.get(key);
  if (existing !== undefined) return existing;
  const flight = fetchInspection(options, requestedUrl, serviceOrigin).finally(() =>
    active.delete(key)
  );
  active.set(key, flight);
  return flight;
}

async function fetchInspection(
  options: InspectServiceOptions,
  requestedUrl: URL,
  serviceOrigin: string
): Promise<ServiceInspection> {
  const requestHeaders = requestHeaderRecord(options.acceptLanguage);
  const key = cacheKey(requestedUrl, options.acceptLanguage);
  let cached = await options.cache?.get("service-document", key);
  let cachePolicy = cached === undefined ? undefined : restorePolicy(cached);
  if (cached !== undefined && cachePolicy === undefined) {
    await options.cache?.delete("service-document", key);
    cached = undefined;
  }
  const policyRequest = {
    url: cached?.finalUrl ?? String(requestedUrl),
    method: "GET",
    headers: requestHeaders
  };
  if (cached !== undefined && cachePolicy?.satisfiesWithoutRevalidation(policyRequest) === true) {
    try {
      return inspectionFrom(
        cached.value,
        requestedUrl,
        new URL(cached.finalUrl),
        serviceOrigin,
        "fresh"
      );
    } catch {
      await options.cache?.delete("service-document", key);
      cached = undefined;
      cachePolicy = undefined;
    }
  }

  const headers =
    cachePolicy === undefined ? requestHeaders : cachePolicy.revalidationHeaders(policyRequest);
  const revalidationRequest = { ...policyRequest, headers };
  const response = await fetchWithRedirects(
    options,
    new URL(cached?.finalUrl ?? requestedUrl),
    headers,
    serviceOrigin
  );

  if (response.response.status === 304) {
    if (cached === undefined || cachePolicy === undefined) {
      throw new OdpInspectionError(
        "ODP Service Document returned 304 without a cached representation.",
        "http_error",
        304
      );
    }
    const revalidated = cachePolicy.revalidatedPolicy(
      revalidationRequest,
      responseMetadata(response.response)
    );
    if (revalidated.modified) {
      throw new OdpInspectionError(
        "ODP Service Document returned an unusable revalidation response.",
        "http_error",
        304
      );
    }
    const record = {
      ...cached,
      finalUrl: String(response.finalUrl),
      policy: revalidated.policy.toObject()
    };
    await persist(options.cache, record, revalidated.policy.storable());
    return inspectionFrom(
      cached.value,
      requestedUrl,
      response.finalUrl,
      serviceOrigin,
      "revalidated"
    );
  }

  if (!response.response.ok) {
    throw new OdpInspectionError(
      `ODP Service Document failed with HTTP ${response.response.status}.`,
      "http_error",
      response.response.status
    );
  }
  requireMediaType(response.response);
  const bytes = await readBounded(response.response, SERVICE_DOCUMENT_MAX_BYTES);
  const document = parseDocument(bytes);
  const policyResponse = withFallbackFreshness(
    responseMetadata(response.response),
    options.fallbackTtlMs ?? DEFAULT_FALLBACK_TTL_MS
  );
  const policy = new CachePolicy(
    { url: String(response.finalUrl), method: "GET", headers: requestHeaders },
    policyResponse,
    { shared: false }
  );
  const record: OdpCacheRecord<ServiceDocument> = {
    resourceClass: "service-document",
    key,
    url: String(requestedUrl),
    finalUrl: String(response.finalUrl),
    value: document,
    policy: policy.toObject()
  };
  await persist(options.cache, record, policy.storable());
  return inspectionFrom(document, requestedUrl, response.finalUrl, serviceOrigin, "fetched");
}

async function fetchWithRedirects(
  options: InspectServiceOptions,
  initialUrl: URL,
  headers: CachePolicy.Headers,
  serviceOrigin: string
): Promise<{ response: Response; finalUrl: URL }> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function")
    throw new TypeError("ODP inspection requires a fetch implementation.");
  const maximum = options.maxRedirects ?? 5;
  if (!Number.isInteger(maximum) || maximum < 0 || maximum > 5) {
    throw new RangeError("maxRedirects must be an integer from 0 through 5");
  }
  let current = initialUrl;
  try {
    for (let redirects = 0; ; redirects += 1) {
      const response = await fetchImpl(current, {
        method: "GET",
        headers: headersForFetch(headers),
        redirect: "manual",
        ...(options.signal === undefined ? {} : { signal: options.signal })
      });
      if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: current };
      if (redirects >= maximum) {
        throw new OdpInspectionError(
          "ODP Service Document exceeded its redirect limit.",
          "invalid_redirect"
        );
      }
      const location = response.headers.get("location");
      if (location === null) {
        throw new OdpInspectionError(
          "ODP Service Document redirect omitted Location.",
          "invalid_redirect"
        );
      }
      const next = new URL(location, current);
      if (next.origin !== serviceOrigin || next.protocol !== current.protocol) {
        throw new OdpInspectionError(
          "ODP Service Document redirect changed origin or scheme.",
          "invalid_redirect"
        );
      }
      current = next;
    }
  } catch (error) {
    if (error instanceof OdpInspectionError) throw error;
    if (options.signal?.aborted === true) {
      throw new OdpInspectionError("ODP Service Document request was aborted.", "aborted");
    }
    throw new OdpInspectionError("ODP Service Document could not be fetched.", "http_error");
  }
}

function requestHeaderRecord(acceptLanguage?: string): CachePolicy.Headers {
  return {
    accept: ODP_MEDIA_TYPE,
    ...(acceptLanguage === undefined ? {} : { "accept-language": acceptLanguage })
  };
}

function cacheKey(url: URL, acceptLanguage?: string): string {
  return `${String(url)}\u0000${acceptLanguage ?? ""}`;
}

function headersForFetch(headers: CachePolicy.Headers): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) result.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return result;
}

function responseMetadata(response: Response): CachePolicy.HttpResponse {
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()) };
}

function withFallbackFreshness(
  response: CachePolicy.HttpResponse,
  fallbackTtlMs: number
): CachePolicy.HttpResponse {
  if (!Number.isFinite(fallbackTtlMs) || fallbackTtlMs < 0) {
    throw new RangeError("fallbackTtlMs must be a non-negative finite number");
  }
  const headers = { ...response.headers };
  const control = String(headers["cache-control"] ?? "").toLowerCase();
  const explicit =
    headers["expires"] !== undefined ||
    /(?:^|,)\s*(?:max-age|s-maxage|no-cache|no-store)\b/u.test(control);
  if (!explicit) {
    const fallback = `max-age=${Math.floor(fallbackTtlMs / 1000)}`;
    const original = headers["cache-control"];
    headers["cache-control"] = control.length === 0 ? fallback : `${String(original)}, ${fallback}`;
  }
  return { ...response, headers };
}

function requireMediaType(response: Response): void {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== ODP_MEDIA_TYPE) {
    throw new OdpInspectionError(
      "ODP Service Document response media type is invalid.",
      "invalid_media_type"
    );
  }
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new OdpInspectionError(
      "ODP Service Document response is too large.",
      "response_too_large"
    );
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      throw new OdpInspectionError(
        "ODP Service Document response is too large.",
        "response_too_large"
      );
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseDocument(bytes: Uint8Array): ServiceDocument {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new OdpInspectionError("ODP Service Document contains malformed JSON.", "invalid_json");
  }
  if (nestingDepth(value) > SERVICE_DOCUMENT_MAX_DEPTH) {
    throw new OdpInspectionError(
      "ODP Service Document exceeds the nesting-depth limit.",
      "validation_failed"
    );
  }
  try {
    return parseServiceDocument(value);
  } catch {
    throw new OdpInspectionError("ODP Service Document validation failed.", "validation_failed");
  }
}

function nestingDepth(value: unknown): number {
  let maximum = 1;
  const pending: Array<{ depth: number; value: unknown }> = [{ depth: 1, value }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    maximum = Math.max(maximum, current.depth);
    if (typeof current.value !== "object" || current.value === null) continue;
    const children = Array.isArray(current.value) ? current.value : Object.values(current.value);
    children.forEach((child) => pending.push({ depth: current.depth + 1, value: child }));
  }
  return maximum;
}

function restorePolicy(record: OdpCacheRecord): CachePolicy | undefined {
  try {
    return CachePolicy.fromObject(record.policy);
  } catch {
    return undefined;
  }
}

async function persist(
  cache: OdpCache | undefined,
  record: OdpCacheRecord,
  storable: boolean
): Promise<void> {
  if (cache === undefined) return;
  if (storable) await cache.set(record);
  else await cache.delete(record.resourceClass, record.key);
}

function inspectionFrom(
  value: unknown,
  requestedUrl: URL,
  finalUrl: URL,
  serviceOrigin: string,
  freshness: ServiceInspection["freshness"]
): ServiceInspection {
  let document: ServiceDocument;
  try {
    document = parseServiceDocument(structuredClone(value));
  } catch {
    throw new OdpInspectionError(
      "Cached ODP Service Document validation failed.",
      "validation_failed"
    );
  }
  return {
    document,
    requestedUrl,
    finalUrl,
    serviceOrigin,
    freshness,
    capabilities: {
      enrollment: [...(document.protocols?.enrollment ?? [])],
      operations: [...document.operations],
      payments: [...(document.protocols?.payments ?? [])]
    }
  };
}
