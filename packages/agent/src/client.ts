import {
  buildOdpOperationUrl,
  parseCollection,
  parseCollectionSearchRequest,
  parseFilterDefinitionPage,
  parseOffering,
  parseOfferingSearchRequest,
  parseOfferingSearchResponse,
  parsePage,
  parseSortDefinitionPage,
  resolveContinuation,
  resolveResourceReference,
  type Collection,
  type CollectionSearchRequest,
  type Offering,
  type OfferingPage,
  type OfferingSearchRequest,
  type PageEnvelope,
  type Representation,
  type TerseCollection,
  type TerseOffering
} from "@offering-protocol/core";

import { resolveSearchCapabilities, type SearchCapabilityCatalog } from "./capabilities.js";
import {
  inspectService,
  type InspectServiceOptions,
  type ServiceInspection
} from "./inspection.js";
import { createInMemoryOdpCache, type OdpCache } from "./cache.js";
import { resolveOpenApiOperation } from "./openapi.js";
import {
  normalizeActions,
  type OfferingDetails,
  type OfferingIssue,
  type ResolvedAction
} from "./offerings.js";
import { resolveSchema } from "./schemas.js";
import { requestOdpValue, type OdpTransport } from "./transport.js";

export interface OdpServiceClientOptions extends Omit<
  InspectServiceOptions,
  "fallbackTtlMs" | "fetch" | "serviceUrl"
> {
  serviceUrl: string | URL;
  transport?: OdpTransport;
  supportingTransport?: OdpTransport;
  initialPageSize?: number;
  cacheFallbacks?: OdpCacheFallbacks;
  cachePartition?: string;
}

export interface OdpCacheFallbacks {
  serviceDocumentMs?: number;
  collectionMs?: number;
  offeringMs?: number;
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

export type OfferingListOptions = CollectionListOptions;

export interface OfferingSearchOptions {
  query?: string;
  filters?: OfferingSearchRequest["filters"];
  collection_id?: string;
  include_descendants?: boolean;
  sort?: string;
  refinements?: string[];
  limit?: number;
  representation?: Representation;
  maxPages?: number;
  maxItems?: number;
  signal?: AbortSignal;
}

export type OfferingGetOptions = CollectionGetOptions;

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
  listOfferings(
    options?: OfferingListOptions & { representation?: "terse" }
  ): CollectionSequence<TerseOffering>;
  listOfferings(
    options: OfferingListOptions & { representation: "full" }
  ): CollectionSequence<Offering>;
  listCollectionOfferings(
    collectionId: string,
    options?: OfferingListOptions & { representation?: "terse" }
  ): CollectionSequence<TerseOffering>;
  listCollectionOfferings(
    collectionId: string,
    options: OfferingListOptions & { representation: "full" }
  ): CollectionSequence<Offering>;
  searchOfferings(
    options: OfferingSearchOptions & { representation?: "terse" }
  ): CollectionSequence<TerseOffering>;
  searchOfferings(
    options: OfferingSearchOptions & { representation: "full" }
  ): CollectionSequence<Offering>;
  getOffering(
    id: string,
    options?: OfferingGetOptions & { representation?: "full" }
  ): Promise<OfferingDetails>;
  getOffering(
    id: string,
    options: OfferingGetOptions & { representation: "terse" }
  ): Promise<TerseOffering>;
  getOfferingSearchCapabilities(
    collectionId?: string,
    options?: { signal?: AbortSignal }
  ): Promise<SearchCapabilityCatalog>;
  resolveAction(
    offeringId: string,
    actionId: string,
    options?: { signal?: AbortSignal }
  ): Promise<ResolvedAction>;
}

export function createOdpServiceClient(options: OdpServiceClientOptions): OdpServiceClient {
  const transport = options.transport ?? globalThis.fetch;
  const supportingTransport = options.supportingTransport ?? globalThis.fetch;
  const cache = options.cache ?? createInMemoryOdpCache();
  if (options.cachePartition !== undefined && options.cachePartition.length === 0)
    throw new RangeError("cachePartition must not be empty");
  const catalogCache =
    options.transport === undefined || options.cachePartition !== undefined ? cache : undefined;
  const cachePartition = options.cachePartition ?? "public";
  const fallbacks = {
    serviceDocumentMs: options.cacheFallbacks?.serviceDocumentMs ?? 14_400_000,
    collectionMs: options.cacheFallbacks?.collectionMs ?? 3_600_000,
    offeringMs: options.cacheFallbacks?.offeringMs ?? 300_000,
    searchMs: options.cacheFallbacks?.searchMs ?? 0,
    searchDefinitionMs: options.cacheFallbacks?.searchDefinitionMs ?? 3_600_000
  };
  for (const [name, value] of Object.entries(fallbacks)) requireFallback(value, name);
  const initialPageSize = options.initialPageSize ?? 50;
  requireLimit(initialPageSize, "initialPageSize");
  let inspectionFlight: Promise<ServiceInspection> | undefined;
  const inspect = (signal?: AbortSignal): Promise<ServiceInspection> => {
    if (signal !== undefined)
      return inspectService({
        serviceUrl: options.serviceUrl,
        fetch: transport,
        ...(options.acceptLanguage === undefined ? {} : { acceptLanguage: options.acceptLanguage }),
        cache,
        fallbackTtlMs: fallbacks.serviceDocumentMs,
        ...(options.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects }),
        signal: options.signal === undefined ? signal : AbortSignal.any([options.signal, signal])
      });
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

  const offeringSequence = <Item>(
    operation: "list-offerings" | "list-collection-offerings" | "search-offerings",
    request: OfferingListOptions | OfferingSearchOptions,
    collectionId?: string,
    body?: OfferingSearchRequest
  ): CollectionSequence<Item> => {
    const pages = (): AsyncGenerator<OfferingPage<Item>> =>
      offeringPages<Item>(
        inspect,
        transport,
        operation,
        request,
        initialPageSize,
        options.acceptLanguage,
        catalogCache,
        cachePartition,
        fallbacks,
        collectionId,
        body
      );
    return {
      pages: { [Symbol.asyncIterator]: pages },
      items: itemIterable(pages, request.maxItems)
    };
  };

  function listOfferings(
    request?: OfferingListOptions & { representation?: "terse" }
  ): CollectionSequence<TerseOffering>;
  function listOfferings(
    request: OfferingListOptions & { representation: "full" }
  ): CollectionSequence<Offering>;
  function listOfferings(
    request: OfferingListOptions = {}
  ): CollectionSequence<TerseOffering> | CollectionSequence<Offering> {
    return request.representation === "full"
      ? offeringSequence<Offering>("list-offerings", request)
      : offeringSequence<TerseOffering>("list-offerings", request);
  }

  function listCollectionOfferings(
    collectionId: string,
    request?: OfferingListOptions & { representation?: "terse" }
  ): CollectionSequence<TerseOffering>;
  function listCollectionOfferings(
    collectionId: string,
    request: OfferingListOptions & { representation: "full" }
  ): CollectionSequence<Offering>;
  function listCollectionOfferings(
    collectionId: string,
    request: OfferingListOptions = {}
  ): CollectionSequence<TerseOffering> | CollectionSequence<Offering> {
    return request.representation === "full"
      ? offeringSequence<Offering>("list-collection-offerings", request, collectionId)
      : offeringSequence<TerseOffering>("list-collection-offerings", request, collectionId);
  }

  function searchOfferings(
    request: OfferingSearchOptions & { representation?: "terse" }
  ): CollectionSequence<TerseOffering>;
  function searchOfferings(
    request: OfferingSearchOptions & { representation: "full" }
  ): CollectionSequence<Offering>;
  function searchOfferings(
    request: OfferingSearchOptions
  ): CollectionSequence<TerseOffering> | CollectionSequence<Offering> {
    const body = parseOfferingSearchRequest({
      odp_version: "1.0",
      ...(request.query === undefined ? {} : { query: request.query }),
      ...(request.filters === undefined ? {} : { filters: request.filters }),
      ...(request.collection_id === undefined ? {} : { collection_id: request.collection_id }),
      ...(request.include_descendants === undefined
        ? {}
        : { include_descendants: request.include_descendants }),
      ...(request.sort === undefined ? {} : { sort: request.sort }),
      ...(request.refinements === undefined ? {} : { refinements: request.refinements }),
      ...(request.limit === undefined ? {} : { limit: request.limit })
    });
    return request.representation === "full"
      ? offeringSequence<Offering>("search-offerings", request, undefined, body)
      : offeringSequence<TerseOffering>("search-offerings", request, undefined, body);
  }

  function getOffering(
    id: string,
    request?: OfferingGetOptions & { representation?: "full" }
  ): Promise<OfferingDetails>;
  function getOffering(
    id: string,
    request: OfferingGetOptions & { representation: "terse" }
  ): Promise<TerseOffering>;
  async function getOffering(
    id: string,
    request: OfferingGetOptions = {}
  ): Promise<OfferingDetails | TerseOffering> {
    const { offering, url } = await getOfferingWire(id, request);
    if (request.representation === "terse") return parseOfferingItem(offering, "1.0", false);
    return enrichOffering(offering, url, request.signal);
  }

  async function getOfferingWire(
    id: string,
    request: OfferingGetOptions
  ): Promise<{ offering: Offering; url: URL }> {
    const inspected = requireOperation(await inspect(request.signal), "get-offering");
    const url = buildOdpOperationUrl(
      inspected.document.http.endpoint_base,
      "get-offering",
      inspected.serviceOrigin,
      id
    );
    addRepresentation(url, request.representation);
    const offering = parseOffering(
      await requestOdpValue(
        transport,
        url,
        requestInit("GET", request.signal),
        options.acceptLanguage,
        catalogCache,
        cachePartition,
        "offering",
        fallbacks.offeringMs,
        parseOffering
      )
    );
    requireResourceId(offering.id, id, "Offering");
    return { offering, url };
  }

  async function enrichOffering(
    offering: Offering,
    offeringUrl: URL,
    signal?: AbortSignal
  ): Promise<OfferingDetails> {
    const { actions: wireActions, attributes, ...envelope } = offering;
    const normalized = normalizeActions(wireActions, offeringUrl.origin);
    const issues: OfferingIssue[] = [...normalized.issues];
    let safeAttributes = attributes;
    let attributeSchema: Awaited<ReturnType<typeof resolveSchema>> | undefined;
    if (offering.schema !== undefined) {
      try {
        attributeSchema = await resolveSchema({
          url: resolveResourceReference(offering.schema.url, offeringUrl),
          transport: supportingTransport,
          cache,
          ...(signal === undefined ? {} : { signal })
        });
        if (attributes !== undefined && !attributeSchema.validate(attributes)) {
          safeAttributes = undefined;
          issues.push({
            scope: "attributes",
            message: "Offering attributes do not match their Attribute Schema"
          });
        }
      } catch (error) {
        safeAttributes = undefined;
        issues.push({
          scope: "attribute_schema",
          message: error instanceof Error ? error.message : "Attribute Schema resolution failed"
        });
      }
    }
    return {
      ...envelope,
      ...(safeAttributes === undefined ? {} : { attributes: safeAttributes }),
      ...(attributeSchema === undefined ? {} : { attribute_schema: attributeSchema.schema }),
      ...(normalized.actions === undefined ? {} : { actions: normalized.actions }),
      ...(issues.length === 0 ? {} : { issues })
    };
  }

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
      const inspected = requireOperation(await inspect(request.signal), "get-collection");
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
      const collection = parseCollection(value);
      requireResourceId(collection.id, id, "Collection");
      return collection;
    },
    async getCollectionSearchCapabilities(id, request = {}) {
      const inspected = await inspect(request.signal);
      const collection = await this.getCollection(id, {
        representation: "full",
        ...(request.signal === undefined ? {} : { signal: request.signal })
      });
      return resolveCapabilities(inspected, collection.search_capabilities, request.signal);
    },
    listOfferings,
    listCollectionOfferings,
    searchOfferings,
    getOffering,
    async resolveAction(offeringId, actionId, request = {}) {
      const { offering, url } = await getOfferingWire(offeringId, {
        representation: "full",
        ...(request.signal === undefined ? {} : { signal: request.signal })
      });
      const normalized = normalizeActions(offering.actions, url.origin);
      const action = normalized.actions?.find(({ id }) => id === actionId);
      if (action === undefined)
        throw new Error(`ODP Offering does not expose usable Action ${actionId}`);
      if (action.target.kind === "http") {
        const httpAction = { ...action, target: action.target };
        const reference = action.target.request?.schema;
        if (reference === undefined) return { action: httpAction };
        const resolved = await resolveSchema({
          url: resolveResourceReference(reference.url, url),
          transport: supportingTransport,
          cache,
          ...(request.signal === undefined ? {} : { signal: request.signal })
        });
        return { action: httpAction, request_schema: resolved.schema };
      }
      const openApiAction = { ...action, target: action.target };
      const resolved = await resolveOpenApiOperation({
        url: new URL(action.target.url),
        operationId: action.target.operation_id,
        transport: supportingTransport,
        cache,
        ...(request.signal === undefined ? {} : { signal: request.signal })
      });
      return {
        action: openApiAction,
        openapi_document: resolved.document,
        operation: resolved.operation
      };
    },
    async getOfferingSearchCapabilities(collectionId, request = {}) {
      const inspected = await inspect(request.signal);
      const collection =
        collectionId === undefined
          ? undefined
          : await this.getCollection(collectionId, {
              representation: "full",
              ...(request.signal === undefined ? {} : { signal: request.signal })
            });
      return resolveCapabilities(inspected, collection?.search_capabilities, request.signal);
    }
  };

  function resolveCapabilities(
    inspected: ServiceInspection,
    collection: Collection["search_capabilities"],
    signal?: AbortSignal
  ): Promise<SearchCapabilityCatalog> {
    return resolveSearchCapabilities({
      inspection: inspected,
      collection,
      ...(signal === undefined ? {} : { signal }),
      async loadPage(kind, href, pageSignal) {
        const url = resolveContinuation(href, inspected.serviceOrigin);
        const parser = kind === "filters" ? parseFilterDefinitionPage : parseSortDefinitionPage;
        return parser(
          await requestOdpValue(
            transport,
            url,
            requestInit("GET", pageSignal),
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
}

async function* collectionPages<Item>(
  inspect: (signal?: AbortSignal) => Promise<ServiceInspection>,
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
  const inspected = requireOperation(await inspect(request.signal), operation);
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

async function* offeringPages<Item>(
  inspect: (signal?: AbortSignal) => Promise<ServiceInspection>,
  transport: OdpTransport,
  operation: "list-offerings" | "list-collection-offerings" | "search-offerings",
  request: OfferingListOptions | OfferingSearchOptions,
  defaultLimit: number,
  acceptLanguage: string | undefined,
  cache: OdpCache | undefined,
  cachePartition: string,
  fallbacks: Required<OdpCacheFallbacks>,
  collectionId?: string,
  body?: OfferingSearchRequest
): AsyncGenerator<OfferingPage<Item>> {
  const inspected = requireOperation(await inspect(request.signal), operation);
  const url = buildOdpOperationUrl(
    inspected.document.http.endpoint_base,
    operation,
    inspected.serviceOrigin,
    collectionId
  );
  addRepresentation(url, request.representation);
  const limit = request.limit ?? defaultLimit;
  requireLimit(limit, "limit");
  let init: RequestInit =
    operation === "search-offerings"
      ? { ...requestInit("POST", request.signal), body: JSON.stringify({ ...body, limit }) }
      : requestInit("GET", request.signal);
  if (operation !== "search-offerings") url.searchParams.set("limit", String(limit));
  const maximum = request.maxPages ?? 16;
  requirePageLimit(maximum);
  const visited = new Set<string>();
  let current = url;
  for (let count = 0; count < maximum; count += 1) {
    const parser = operation === "search-offerings" ? parseOfferingSearchResponse : parsePage;
    const raw = parser(
      await requestOdpValue(
        transport,
        current,
        init,
        acceptLanguage,
        cache,
        cachePartition,
        operation === "search-offerings" ? "search" : "offering",
        operation === "search-offerings" ? fallbacks.searchMs : fallbacks.offeringMs,
        parser
      )
    ) as OfferingPage;
    if (count > 0 && raw.refinements !== undefined)
      throw new TypeError("ODP Offering search continuation cannot contain refinements");
    const page = {
      ...raw,
      items: raw.items.map((item) =>
        parseOfferingItem(item, raw.odp_version, request.representation === "full")
      )
    } as OfferingPage<Item>;
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
  operation:
    | "list-collections"
    | "search-collections"
    | "get-collection"
    | "list-offerings"
    | "list-collection-offerings"
    | "search-offerings"
    | "get-offering"
): ServiceInspection {
  if (!inspection.capabilities.operations.includes(operation))
    throw new Error(`ODP Service does not advertise ${operation}`);
  return inspection;
}

function parseOfferingItem(value: unknown, version: "1.0", full: true): Offering;
function parseOfferingItem(value: unknown, version: "1.0", full: false): TerseOffering;
function parseOfferingItem(value: unknown, version: "1.0", full: boolean): Offering | TerseOffering;
function parseOfferingItem(
  value: unknown,
  version: "1.0",
  full: boolean
): Offering | TerseOffering {
  if (typeof value !== "object" || value === null) return parseOffering(value);
  const parsed = parseOffering({ odp_version: version, ...value });
  if (full) return parsed;
  if ("actions" in value) throw new TypeError("ODP Terse Offering cannot contain actions");
  return structuredClone(value) as TerseOffering;
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

function requireResourceId(actual: string, expected: string, type: string): void {
  if (actual !== expected)
    throw new TypeError(`${type} identifier does not match its request path`);
}

function requestInit(method: "GET" | "POST", signal?: AbortSignal): RequestInit {
  return { method, ...(signal === undefined ? {} : { signal }) };
}
