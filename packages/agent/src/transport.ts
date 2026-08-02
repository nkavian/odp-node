import CachePolicy from "http-cache-semantics";

import { parseProblemResponse, type ProblemDetails } from "@offering-protocol/core";

import type { OdpCache, OdpCacheRecord, OdpCacheResourceClass } from "./cache.js";

const MEDIA_TYPE = "application/odp+json";
const MAX_BYTES = 524_288;
const requestFlights = new WeakMap<OdpCache, Map<string, Promise<unknown>>>();

export type OdpTransport = typeof globalThis.fetch;

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
  validate?: (value: unknown) => unknown
): Promise<unknown> {
  if (init.method !== "GET" || cache === undefined)
    return requestUncoalesced(
      transport,
      url,
      init,
      acceptLanguage,
      cache,
      cachePartition,
      resourceClass,
      fallbackTtlMs,
      validate
    );
  const key = `${resourceClass}\u0000${cachePartition}\u0000${String(url)}\u0000${acceptLanguage ?? ""}`;
  const active = requestFlights.get(cache) ?? new Map<string, Promise<unknown>>();
  requestFlights.set(cache, active);
  const existing = active.get(key);
  if (existing !== undefined) return structuredClone(await existing);
  const flight = requestUncoalesced(
    transport,
    url,
    init,
    acceptLanguage,
    cache,
    cachePartition,
    resourceClass,
    fallbackTtlMs,
    validate
  ).finally(() => active.delete(key));
  active.set(key, flight);
  return structuredClone(await flight);
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
  validate?: (value: unknown) => unknown
): Promise<unknown> {
  if (init.method !== "GET" || cache === undefined)
    return validated(
      await responseJson(await send(transport, url, init, acceptLanguage)),
      validate
    );
  const key = `${cachePartition}\u0000${String(url)}\u0000${acceptLanguage ?? ""}`;
  let cached = await cache.get(resourceClass, key);
  let policy: CachePolicy | undefined;
  try {
    if (cached !== undefined) policy = CachePolicy.fromObject(cached.policy);
  } catch {
    await cache.delete(resourceClass, key);
    cached = undefined;
  }
  const request = { url: String(url), method: "GET", headers: requestHeaders(acceptLanguage) };
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
  const response = await send(
    transport,
    url,
    { ...init, headers: headersForFetch(headers) },
    acceptLanguage
  );
  if (response.status === 304) {
    if (cached === undefined || policy === undefined)
      throw new Error("ODP response returned 304 without a cached representation");
    const result = policy.revalidatedPolicy({ ...request, headers }, responseMetadata(response));
    await cache.set({ ...cached, policy: result.policy.toObject() });
    try {
      return validated(structuredClone(cached.value), validate);
    } catch {
      await cache.delete(resourceClass, key);
      return requestUncoalesced(
        transport,
        url,
        init,
        acceptLanguage,
        cache,
        cachePartition,
        resourceClass,
        fallbackTtlMs,
        validate
      );
    }
  }
  const value = validated(await responseJson(response), validate);
  const metadata = withFallback(responseMetadata(response), fallbackTtlMs);
  const nextPolicy = new CachePolicy(request, metadata, { shared: false });
  const record: OdpCacheRecord = {
    resourceClass,
    key,
    url: String(url),
    finalUrl: String(url),
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
  const control = String(headers["cache-control"] ?? "").toLowerCase();
  const explicit =
    headers["expires"] !== undefined ||
    /(?:^|,)\s*(?:max-age|s-maxage|no-cache|no-store)\b/u.test(control);
  if (!explicit) headers["cache-control"] = `max-age=${Math.floor(milliseconds / 1000)}`;
  return { ...response, headers };
}

async function send(
  transport: OdpTransport,
  url: URL,
  init: RequestInit,
  acceptLanguage?: string
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("accept", MEDIA_TYPE);
  if (init.body !== undefined) headers.set("content-type", MEDIA_TYPE);
  if (acceptLanguage !== undefined) headers.set("accept-language", acceptLanguage);
  let current = url;
  let request = { ...init, headers, redirect: "manual" as const };
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    response = await transport(current, request);
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    if (redirects === 5) throw new Error("ODP response exceeded its redirect limit");
    const location = response.headers.get("location");
    if (location === null) throw new Error("ODP redirect omitted Location");
    const next = new URL(location, current);
    if (next.origin !== current.origin) throw new Error("ODP redirect changed origin");
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && request.method === "POST")
    )
      request = { method: "GET", headers, redirect: "manual" };
    current = next;
  }
  if (response === undefined) throw new Error("ODP request produced no response");
  if (!response.ok && response.status !== 304) {
    let problem: ProblemDetails | undefined;
    if (response.headers.get("content-type")?.startsWith("application/problem+json") === true) {
      try {
        problem = parseProblemResponse(await responseJson(response, 16_384), response.status);
      } catch {
        problem = undefined;
      }
    }
    throw new OdpRequestError(response, problem);
  }
  if (response.status === 304) return response;
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== MEDIA_TYPE)
    throw new TypeError("ODP response media type is invalid");
  return response;
}

async function responseJson(response: Response, maximum = MAX_BYTES): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum)
    throw new RangeError("ODP response exceeds its byte limit");
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
  if (depth(value) > 16) throw new RangeError("ODP response exceeds its nesting-depth limit");
  return value;
}

function depth(value: unknown): number {
  let maximum = 1;
  const pending: Array<{ depth: number; value: unknown }> = [{ depth: 1, value }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    maximum = Math.max(maximum, current.depth);
    if (typeof current.value !== "object" || current.value === null) continue;
    const children = Array.isArray(current.value) ? current.value : Object.values(current.value);
    for (const child of children) pending.push({ depth: current.depth + 1, value: child });
  }
  return maximum;
}

function validated(value: unknown, validate?: (value: unknown) => unknown): unknown {
  return validate === undefined ? value : validate(value);
}

function requestHeaders(acceptLanguage?: string): CachePolicy.Headers {
  return {
    accept: MEDIA_TYPE,
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
