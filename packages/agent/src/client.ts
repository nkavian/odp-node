import {
  buildOdpOperationUrl,
  parseCollection,
  parseCollectionSearchRequest,
  parseFilterDefinitionPage,
  parsePage,
  parseSortDefinitionPage,
  resolveContinuation,
  type Collection,
  type CollectionSearchRequest,
  type PageEnvelope,
  type Representation,
  type TerseCollection
} from "@offering-protocol/core";

import { resolveSearchCapabilities, type SearchCapabilityCatalog } from "./capabilities.js";
import {
  inspectService,
  type InspectServiceOptions,
  type ServiceInspection
} from "./inspection.js";
import { createInMemoryOdpCache, type OdpCache } from "./cache.js";
import { requestOdpValue, type OdpTransport } from "./transport.js";

export interface OdpServiceClientOptions extends Omit<
  InspectServiceOptions,
  "fallbackTtlMs" | "fetch" | "serviceUrl"
> {
  serviceUrl: string | URL;
  transport?: OdpTransport;
  initialPageSize?: number;
  cacheFallbacks?: OdpCacheFallbacks;
  cachePartition?: string;
}

export interface OdpCacheFallbacks {
  serviceDocumentMs?: number;
  collectionMs?: number;
  searchMs?: number;
  searchDefinitionMs?: number;
}

export interface CollectionListOptions {
  representation?: Representation;
  limit?: number;
  maxPages?: number;
  maxItems?: number;
  signal?: AbortSignal;
}

export interface CollectionSearchOptions {
  query?: string;
  parent_id?: string | null;
  limit?: number;
  representation?: Representation;
  maxPages?: number;
  maxItems?: number;
  signal?: AbortSignal;
}

export interface CollectionGetOptions {
  representation?: Representation;
  signal?: AbortSignal;
}

export interface CollectionSequence<Item> {
  items: AsyncIterable<Item>;
  pages: AsyncIterable<PageEnvelope<Item>>;
}

export interface OdpServiceClient {
  inspect(): Promise<ServiceInspection>;
  listCollections(
    options?: CollectionListOptions & { representation?: "terse" }
  ): CollectionSequence<TerseCollection>;
  listCollections(
    options: CollectionListOptions & { representation: "full" }
  ): CollectionSequence<Collection>;
  searchCollections(
    options: CollectionSearchOptions & { representation?: "terse" }
  ): CollectionSequence<TerseCollection>;
  searchCollections(
    options: CollectionSearchOptions & { representation: "full" }
  ): CollectionSequence<Collection>;
  getCollection(
    id: string,
    options?: CollectionGetOptions & { representation?: "full" }
  ): Promise<Collection>;
  getCollection(
    id: string,
    options: CollectionGetOptions & { representation: "terse" }
  ): Promise<TerseCollection>;
  getCollectionSearchCapabilities(
    id: string,
    options?: { signal?: AbortSignal }
  ): Promise<SearchCapabilityCatalog>;
}

export function createOdpServiceClient(options: OdpServiceClientOptions): OdpServiceClient {
  const transport = options.transport ?? globalThis.fetch;
  const cache = options.cache ?? createInMemoryOdpCache();
  if (options.cachePartition !== undefined && options.cachePartition.length === 0)
    throw new RangeError("cachePartition must not be empty");
  const catalogCache =
    options.transport === undefined || options.cachePartition !== undefined ? cache : undefined;
  const cachePartition = options.cachePartition ?? "public";
  const fallbacks = {
    serviceDocumentMs: options.cacheFallbacks?.serviceDocumentMs ?? 14_400_000,
    collectionMs: options.cacheFallbacks?.collectionMs ?? 3_600_000,
    searchMs: options.cacheFallbacks?.searchMs ?? 0,
    searchDefinitionMs: options.cacheFallbacks?.searchDefinitionMs ?? 3_600_000
  };
  for (const [name, value] of Object.entries(fallbacks)) requireFallback(value, name);
  const initialPageSize = options.initialPageSize ?? 50;
  requireLimit(initialPageSize, "initialPageSize");
  let inspectionFlight: Promise<ServiceInspection> | undefined;
  const inspect = (): Promise<ServiceInspection> => {
    inspectionFlight ??= inspectService({
      serviceUrl: options.serviceUrl,
      fetch: transport,
      ...(options.acceptLanguage === undefined ? {} : { acceptLanguage: options.acceptLanguage }),
      cache,
      fallbackTtlMs: fallbacks.serviceDocumentMs,
      ...(options.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects }),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    }).finally(() => {
      inspectionFlight = undefined;
    });
    return inspectionFlight;
  };

  const sequence = <Item>(
    operation: "list-collections" | "search-collections",
    request: CollectionListOptions | CollectionSearchOptions,
    body?: CollectionSearchRequest
  ): CollectionSequence<Item> => {
    const pages = (): AsyncGenerator<PageEnvelope<Item>> =>
      collectionPages<Item>(
        inspect,
        transport,
        operation,
        request,
        initialPageSize,
        options.acceptLanguage,
        catalogCache,
        cachePartition,
        fallbacks,
        body
      );
    return {
      pages: { [Symbol.asyncIterator]: pages },
      items: itemIterable(pages, request.maxItems)
    };
  };

  return {
    inspect,
    listCollections(request = {}) {
      return sequence("list-collections", request);
    },
    searchCollections(request) {
      return sequence(
        "search-collections",
        request,
        parseCollectionSearchRequest({
          odp_version: "1.0",
          ...(request.query === undefined ? {} : { query: request.query }),
          ...(request.parent_id === undefined ? {} : { parent_id: request.parent_id }),
          ...(request.limit === undefined ? {} : { limit: request.limit })
        })
      );
    },
    async getCollection(id, request = {}) {
      const inspected = requireOperation(await inspect(), "get-collection");
      const url = buildOdpOperationUrl(
        inspected.document.http.endpoint_base,
        "get-collection",
        inspected.serviceOrigin,
        id
      );
      addRepresentation(url, request.representation);
      const value = await requestOdpValue(
        transport,
        url,
        requestInit("GET", request.signal),
        options.acceptLanguage,
        catalogCache,
        cachePartition,
        "collection",
        fallbacks.collectionMs,
        parseCollection
      );
      return parseCollection(value);
    },
    async getCollectionSearchCapabilities(id, request = {}) {
      const inspected = await inspect();
      const collection = await this.getCollection(id, {
        representation: "full",
        ...(request.signal === undefined ? {} : { signal: request.signal })
      });
      return resolveSearchCapabilities({
        inspection: inspected,
        collection: collection.search_capabilities,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        async loadPage(kind, href, signal) {
          const url = resolveContinuation(href, inspected.serviceOrigin);
          const parser = kind === "filters" ? parseFilterDefinitionPage : parseSortDefinitionPage;
          return parser(
            await requestOdpValue(
              transport,
              url,
              requestInit("GET", signal),
              options.acceptLanguage,
              catalogCache,
              cachePartition,
              "search-definition",
              fallbacks.searchDefinitionMs,
              parser
            )
          );
        }
      });
    }
  };
}

async function* collectionPages<Item>(
  inspect: () => Promise<ServiceInspection>,
  transport: OdpTransport,
  operation: "list-collections" | "search-collections",
  request: CollectionListOptions | CollectionSearchOptions,
  defaultLimit: number,
  acceptLanguage: string | undefined,
  cache: OdpCache | undefined,
  cachePartition: string,
  fallbacks: Required<OdpCacheFallbacks>,
  body?: CollectionSearchRequest
): AsyncGenerator<PageEnvelope<Item>> {
  const inspected = requireOperation(await inspect(), operation);
  const url = buildOdpOperationUrl(
    inspected.document.http.endpoint_base,
    operation,
    inspected.serviceOrigin
  );
  addRepresentation(url, request.representation);
  const limit = request.limit ?? defaultLimit;
  requireLimit(limit, "limit");
  let init: RequestInit =
    operation === "search-collections"
      ? { ...requestInit("POST", request.signal), body: JSON.stringify({ ...body, limit }) }
      : requestInit("GET", request.signal);
  if (operation === "list-collections") url.searchParams.set("limit", String(limit));
  const maximum = request.maxPages ?? 16;
  requirePageLimit(maximum);
  const visited = new Set<string>();
  let current = url;
  for (let count = 0; count < maximum; count += 1) {
    const raw = parsePage(
      await requestOdpValue(
        transport,
        current,
        init,
        acceptLanguage,
        cache,
        cachePartition,
        operation === "search-collections" ? "search" : "collection",
        operation === "search-collections" ? fallbacks.searchMs : fallbacks.collectionMs,
        parsePage
      )
    );
    const page = {
      ...raw,
      items: raw.items.map((item) =>
        parseCollectionItem(item, raw.odp_version, request.representation === "full")
      )
    } as PageEnvelope<Item>;
    yield page;
    if (page.next === undefined) return;
    if (visited.has(page.next)) throw new Error("ODP pagination loop detected");
    visited.add(page.next);
    current = resolveContinuation(page.next, inspected.serviceOrigin);
    init = requestInit("GET", request.signal);
  }
  throw new RangeError("ODP pagination exceeded the 16-page traversal limit");
}

function itemIterable<Item>(
  pages: () => AsyncGenerator<PageEnvelope<Item>>,
  maximum?: number
): AsyncIterable<Item> {
  if (maximum !== undefined && (!Number.isInteger(maximum) || maximum < 1))
    throw new RangeError("maxItems must be a positive integer");
  return {
    async *[Symbol.asyncIterator]() {
      let count = 0;
      for await (const page of pages()) {
        for (const item of page.items) {
          if (maximum !== undefined && count >= maximum) return;
          count += 1;
          yield item;
        }
      }
    }
  };
}

function requireOperation(
  inspection: ServiceInspection,
  operation: "list-collections" | "search-collections" | "get-collection"
): ServiceInspection {
  if (!inspection.capabilities.operations.includes(operation))
    throw new Error(`ODP Service does not advertise ${operation}`);
  return inspection;
}

function parseCollectionItem(
  value: unknown,
  version: "1.0",
  full: boolean
): Collection | TerseCollection {
  if (typeof value !== "object" || value === null) return parseCollection(value);
  const parsed = parseCollection({ odp_version: version, ...value });
  if (full) return parsed;
  return structuredClone(value) as TerseCollection;
}

function addRepresentation(url: URL, representation?: Representation): void {
  if (representation !== undefined) url.searchParams.set("representation", representation);
}

function requireLimit(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 100)
    throw new RangeError(`${name} must be an integer from 1 through 100`);
}

function requirePageLimit(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 16)
    throw new RangeError("maxPages must be an integer from 1 through 16");
}

function requireFallback(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative finite number`);
}

function requestInit(method: "GET" | "POST", signal?: AbortSignal): RequestInit {
  return { method, ...(signal === undefined ? {} : { signal }) };
}
