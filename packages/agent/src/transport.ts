import { createHash } from "node:crypto";

import CachePolicy from "http-cache-semantics";

import {
  normalizeAgentResponse,
  parseProblemResponse,
  type ProblemDetails
} from "@offering-protocol/core";

import type { OdpCache, OdpCacheRecord, OdpCacheResourceClass } from "./cache.js";

const MEDIA_TYPE = "application/odp+json";
const MAX_BYTES = 524_288;
/** ERR-21: JSON nesting depth is 16 for every ODP document except the Service Document. */
const MAX_DEPTH = 16;
const PROBLEM_MAX_BYTES = 16_384;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Headers this layer owns. Caller-supplied copies are ignored so they cannot poison the cache key. */
const MANAGED_HEADERS = new Set(["accept", "accept-language", "content-type"]);
const ODP_FORMAT: JsonResponseFormat = {
  accept: MEDIA_TYPE,
  mediaTypes: [MEDIA_TYPE],
  maximumBytes: MAX_BYTES,
  maximumDepth: MAX_DEPTH
};
const requestFlights = new WeakMap<OdpCache, Map<string, Flight>>();

export type OdpTransport = (url: URL, init?: RequestInit) => Promise<Response>;

interface JsonResponseFormat {
  accept: string;
  mediaTypes: string[];
  maximumBytes: number;
  maximumDepth: number;
}

interface Flight {
  promise: Promise<unknown>;
  validate: ((value: unknown) => unknown) | undefined;
}

export interface SupportingJsonRequest {
  transport: OdpTransport;
  url: URL;
  cache?: OdpCache;
  cachePartition: string;
  resourceClass: "attribute-schema" | "openapi";
  fallbackTtlMs: number;
  accept: string;
  mediaTypes: string[];
  maximumBytes: number;
  maximumDepth?: number;
  validate?: (value: unknown) => unknown;
  signal?: AbortSignal;
}

export class OdpRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly problem?: ProblemDetails;
  readonly headers: Headers;

  constructor(response: Response, problem?: ProblemDetails) {
    super(problem?.detail ?? problem?.title ?? `ODP request failed with HTTP ${response.status}`);
    this.name = "OdpRequestError";
    this.code = problem?.code ?? "HTTP_ERROR";
    this.status = response.status;
    this.retryable = response.status === 429 || response.status >= 500;
    this.headers = new Headers(response.headers);
    if (problem !== undefined) this.problem = problem;
  }
}

export async function requestOdpValue(
  transport: OdpTransport,
  url: URL,
  init: RequestInit,
  acceptLanguage: string | undefined,
  cache: OdpCache | undefined,
  cachePartition: string,
  resourceClass: OdpCacheResourceClass,
  fallbackTtlMs: number,
  validate?: (value: unknown) => unknown,
  format: JsonResponseFormat = ODP_FORMAT
): Promise<unknown> {
  const identity = cacheIdentity(url, init, acceptLanguage, cachePartition);
  if (identity === undefined || cache === undefined || init.signal !== undefined)
    return requestUncoalesced(
      transport,
      url,
      init,
      acceptLanguage,
      cache,
      cachePartition,
      resourceClass,
      fallbackTtlMs,
      validate,
      format
    );
  // The key carries the response format because it decides the media types, byte and depth budgets
  // that the shared fetch is validated against; a caller with a stricter budget must not silently
  // inherit a laxer caller's result.
  const key = `${resourceClass}\u0000${formatIdentity(format)}\u0000${identity}`;
  const active = requestFlights.get(cache) ?? new Map<string, Flight>();
  requestFlights.set(cache, active);
  const existing = active.get(key);
  // Only join a flight whose validator is the very same function: `validate` runs inside the flight,
  // so joining with a different one would return a value this caller never validated.
  if (existing !== undefined && existing.validate === validate)
    return structuredClone(await existing.promise);
  if (existing !== undefined)
    return requestUncoalesced(
      transport,
      url,
      init,
      acceptLanguage,
      cache,
      cachePartition,
      resourceClass,
      fallbackTtlMs,
      validate,
      format
    );
  const promise = requestUncoalesced(
    transport,
    url,
    init,
    acceptLanguage,
    cache,
    cachePartition,
    resourceClass,
    fallbackTtlMs,
    validate,
    format
  ).finally(() => active.delete(key));
  active.set(key, { promise, validate });
  return structuredClone(await promise);
}

export function requestSupportingJson(options: SupportingJsonRequest): Promise<unknown> {
  return requestOdpValue(
    options.transport,
    options.url,
    { method: "GET", ...(options.signal === undefined ? {} : { signal: options.signal }) },
    undefined,
    options.cache,
    options.cachePartition,
    options.resourceClass,
    options.fallbackTtlMs,
    options.validate,
    {
      accept: options.accept,
      mediaTypes: options.mediaTypes,
      maximumBytes: options.maximumBytes,
      maximumDepth: options.maximumDepth ?? MAX_DEPTH
    }
  );
}

async function requestUncoalesced(
  transport: OdpTransport,
  url: URL,
  init: RequestInit,
  acceptLanguage: string | undefined,
  cache: OdpCache | undefined,
  cachePartition: string,
  resourceClass: OdpCacheResourceClass,
  fallbackTtlMs: number,
  validate: ((value: unknown) => unknown) | undefined,
  format: JsonResponseFormat = ODP_FORMAT
): Promise<unknown> {
  const key = cacheIdentity(url, init, acceptLanguage, cachePartition);
  if (key === undefined || cache === undefined) {
    const sent = await send(transport, url, init, acceptLanguage, format);
    return validated(await responseJson(sent.response, format), validate);
  }
  let cached = await cache.get(resourceClass, key);
  let policy: CachePolicy | undefined;
  try {
    if (cached !== undefined) policy = CachePolicy.fromObject(cached.policy);
  } catch {
    await cache.delete(resourceClass, key);
    cached = undefined;
  }
  const request = {
    url: String(url),
    method: init.method ?? "GET",
    // Caller headers participate in both the policy request and the wire request so that
    // `Vary` matching and revalidation reflect what is actually sent.
    headers: requestHeaders(format.accept, acceptLanguage, init.body !== undefined, init.headers)
  };
  if (cached !== undefined && policy?.satisfiesWithoutRevalidation(request) === true) {
    try {
      return validated(structuredClone(cached.value), validate);
    } catch {
      await cache.delete(resourceClass, key);
      cached = undefined;
      policy = undefined;
    }
  }
  const headers = policy?.revalidationHeaders(request) ?? request.headers;
  const sent = await send(
    transport,
    url,
    { ...init, headers: headersForFetch(headers) },
    acceptLanguage,
    format
  );
  const response = sent.response;
  if (response.status === 304) {
    if (cached === undefined || policy === undefined)
      throw new Error("ODP response returned 304 without a cached representation");
    const result = policy.revalidatedPolicy({ ...request, headers }, responseMetadata(response));
    // `modified` is always false for a 304, so it says nothing; `matches` is the meaningful field.
    // It is only conclusive when the 304 actually carried a validator — a bare 304 is legitimate
    // and must still be honoured (RFC 9110 only recommends echoing the entity tag).
    if (suppliesValidator(response) && !result.matches) {
      await cache.delete(resourceClass, key);
      return requestUncoalesced(
        transport,
        url,
        { ...init, headers: headersForFetch(request.headers) },
        acceptLanguage,
        cache,
        cachePartition,
        resourceClass,
        fallbackTtlMs,
        validate,
        format
      );
    }
    const revalidated: OdpCacheRecord = {
      ...cached,
      finalUrl: String(sent.finalUrl),
      policy: result.policy.toObject()
    };
    if (result.policy.storable()) await cache.set(revalidated);
    else await cache.delete(resourceClass, key);
    try {
      return validated(structuredClone(cached.value), validate);
    } catch {
      await cache.delete(resourceClass, key);
      return requestUncoalesced(
        transport,
        url,
        { ...init, headers: headersForFetch(request.headers) },
        acceptLanguage,
        cache,
        cachePartition,
        resourceClass,
        fallbackTtlMs,
        validate,
        format
      );
    }
  }
  const value = validated(await responseJson(response, format), validate);
  const received = responseMetadata(response);
  if (request.method === "POST" && !hasExplicitFreshness(received)) {
    await cache.delete(resourceClass, key);
    return value;
  }
  const metadata = request.method === "GET" ? withFallback(received, fallbackTtlMs) : received;
  const nextPolicy = new CachePolicy(request, metadata, { shared: false });
  const record: OdpCacheRecord = {
    resourceClass,
    key,
    url: String(url),
    finalUrl: String(sent.finalUrl),
    value,
    policy: nextPolicy.toObject()
  };
  if (nextPolicy.storable()) await cache.set(record);
  else await cache.delete(resourceClass, key);
  return value;
}

function withFallback(
  response: CachePolicy.HttpResponse,
  milliseconds: number
): CachePolicy.HttpResponse {
  const headers = { ...response.headers };
  const original = headers["cache-control"];
  const control = String(original ?? "").toLowerCase();
  const explicit =
    headers["expires"] !== undefined ||
    /(?:^|,)\s*(?:max-age|s-maxage|no-cache|no-store)\b/u.test(control);
  if (explicit) return { ...response, headers };
  // CCH-04: a fallback supplies freshness where none was given; it must not discard directives the
  // response did send (`must-revalidate`, `private`, `no-transform`, ...).
  const fallback = `max-age=${Math.floor(milliseconds / 1000)}`;
  headers["cache-control"] =
    control.length === 0 ? fallback : `${String(original ?? "")}, ${fallback}`;
  return { ...response, headers };
}

async function send(
  transport: OdpTransport,
  url: URL,
  init: RequestInit,
  acceptLanguage: string | undefined,
  format: JsonResponseFormat
): Promise<{ response: Response; finalUrl: URL }> {
  const headers = new Headers(init.headers);
  headers.set("accept", format.accept);
  if (init.body === undefined) headers.delete("content-type");
  else headers.set("content-type", MEDIA_TYPE);
  if (acceptLanguage !== undefined) headers.set("accept-language", acceptLanguage);
  let current = url;
  let request: RequestInit = { ...init, headers, redirect: "manual" };
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    response = await transport(current, request);
    if (!REDIRECT_STATUSES.has(response.status)) break;
    if (redirects === 5) {
      await discard(response);
      throw new Error("ODP response exceeded its redirect limit");
    }
    const location = response.headers.get("location");
    if (location === null) {
      await discard(response);
      throw new Error("ODP redirect omitted Location");
    }
    const next = new URL(location, current);
    if (next.origin !== current.origin) {
      await discard(response);
      throw new Error("ODP redirect changed origin");
    }
    await discard(response);
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && request.method === "POST")
    ) {
      // Method change drops the body; everything else about the request — the abort signal above
      // all — has to survive, or the remainder of the chain becomes uncancellable.
      const rewritten = new Headers(headers);
      rewritten.delete("content-type");
      const withoutBody: RequestInit = { ...init };
      delete withoutBody.body;
      request = { ...withoutBody, method: "GET", headers: rewritten, redirect: "manual" };
    }
    current = next;
  }
  if (response === undefined) throw new Error("ODP request produced no response");
  if (!response.ok && response.status !== 304) {
    let problem: ProblemDetails | undefined;
    if (response.headers.get("content-type")?.startsWith("application/problem+json") === true) {
      try {
        problem = parseProblemResponse(
          normalizeAgentResponse(
            await responseJson(response, {
              ...format,
              maximumBytes: PROBLEM_MAX_BYTES,
              maximumDepth: MAX_DEPTH
            }),
            "problem"
          ),
          response.status
        );
      } catch {
        problem = undefined;
      }
    } else await discard(response);
    throw new OdpRequestError(response, problem);
  }
  if (response.status === 304) return { response, finalUrl: current };
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === undefined || !format.mediaTypes.includes(mediaType)) {
    await discard(response);
    throw new TypeError("ODP response media type is invalid");
  }
  return { response, finalUrl: current };
}

/** True when a 304 carried a validator of its own, making a `matches` result conclusive. */
function suppliesValidator(response: Response): boolean {
  return response.headers.get("etag") !== null || response.headers.get("last-modified") !== null;
}

/** Release an unread body so a streaming transport does not leak the connection. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body that is already consumed or errored needs no release.
  }
}

async function responseJson(response: Response, format: JsonResponseFormat): Promise<unknown> {
  const maximum = format.maximumBytes;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    await discard(response);
    throw new RangeError("ODP response exceeds its byte limit");
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader !== undefined) {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new RangeError("ODP response exceeds its byte limit");
      }
      chunks.push(part.value);
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  if (depth(value) > format.maximumDepth)
    throw new RangeError("ODP response exceeds its nesting-depth limit");
  return value;
}

/**
 * Container nesting measured from the top-level value (ERR-18): `{}` and `{"a":1}` are both depth 1,
 * `{"a":{"b":1}}` is depth 2. Scalars are values held by a container, not a level of their own.
 */
function depth(value: unknown): number {
  if (typeof value !== "object" || value === null) return 0;
  let maximum = 0;
  const pending: Array<{ depth: number; value: object }> = [{ depth: 1, value }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    maximum = Math.max(maximum, current.depth);
    const children = Array.isArray(current.value)
      ? (current.value as unknown[])
      : Object.values(current.value as Record<string, unknown>);
    for (const child of children)
      if (typeof child === "object" && child !== null)
        pending.push({ depth: current.depth + 1, value: child });
  }
  return maximum;
}

function validated(value: unknown, validate?: (value: unknown) => unknown): unknown {
  return validate === undefined ? value : validate(value);
}

function formatIdentity(format: JsonResponseFormat): string {
  return [
    format.accept,
    format.mediaTypes.join(","),
    String(format.maximumBytes),
    String(format.maximumDepth)
  ].join("\u0001");
}

/** Caller-supplied headers, lowercased and ordered, excluding the ones this layer sets itself. */
function callerHeaders(source: RequestInit["headers"]): [string, string][] {
  if (source === undefined) return [];
  return [...new Headers(source).entries()]
    .filter(([name]) => !MANAGED_HEADERS.has(name))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

function cacheIdentity(
  url: URL,
  init: RequestInit,
  acceptLanguage: string | undefined,
  cachePartition: string
): string | undefined {
  const method = init.method ?? "GET";
  // Caller headers are part of the identity: an `Authorization` that changes the response must not
  // read a representation stored for a different context (CCH-05, CCH-06, SEC-35).
  const extra = callerHeaders(init.headers)
    .map(([name, value]) => `${name}:${value}`)
    .join("\u0001");
  const prefix = `${cachePartition}\u0000${method}\u0000${String(url)}\u0000${acceptLanguage ?? ""}\u0000${extra}\u0000`;
  if (method === "GET") return prefix;
  if (method !== "POST" || typeof init.body !== "string") return undefined;
  return `${prefix}${createHash("sha256").update(init.body).digest("base64url")}`;
}

function hasExplicitFreshness(response: CachePolicy.HttpResponse): boolean {
  const control = String(response.headers["cache-control"] ?? "").toLowerCase();
  const expires = response.headers["expires"];
  return (
    /(?:^|,)\s*max-age\s*=\s*(?:"\d+"|\d+)/u.test(control) ||
    (typeof expires === "string" && Number.isFinite(Date.parse(expires)))
  );
}

function requestHeaders(
  accept: string,
  acceptLanguage: string | undefined,
  hasBody: boolean,
  caller?: RequestInit["headers"]
): CachePolicy.Headers {
  return {
    ...Object.fromEntries(callerHeaders(caller)),
    accept,
    ...(hasBody ? { "content-type": MEDIA_TYPE } : {}),
    ...(acceptLanguage === undefined ? {} : { "accept-language": acceptLanguage })
  };
}

function headersForFetch(headers: CachePolicy.Headers): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers))
    if (value !== undefined) result.set(name, Array.isArray(value) ? value.join(", ") : value);
  return result;
}

function responseMetadata(response: Response): CachePolicy.HttpResponse {
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()) };
}
