import {
  buildOdpOperationUrl,
  parseCollection,
  parseCollectionSearchRequest,
  parseFilterDefinitionPage,
  normalizeAgentResponse,
  parseOffering,
  parseOfferingSearchRequest,
  parseOfferingSearchResponse,
  parsePage,
  parseSortDefinitionPage,
  resolveContinuation,
  resolveResourceReference,
  type Collection,
  type CollectionSearchRequest,
  type FilterDefinition,
  type Offering,
  type OfferingPage,
  type OfferingSearchRequest,
  type PageEnvelope,
  type Representation,
  type SortDefinition,
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
import { createDefaultTransport } from "./network.js";
import { requestOdpValue, type OdpTransport } from "./transport.js";

export interface OdpServiceClientOptions extends Omit<
  InspectServiceOptions,
  "fallbackTtlMs" | "fetch" | "serviceUrl"
> {
  serviceUrl: string | URL;
  inspectionTransport?: OdpTransport;
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

export type ContinuationOptions = Omit<CollectionListOptions, "limit">;

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
  continueListCollections(
    next: string,
    options?: ContinuationOptions & { representation?: "terse" }
  ): CollectionSequence<TerseCollection>;
  continueListCollections(
    next: string,
    options: ContinuationOptions & { representation: "full" }
  ): CollectionSequence<Collection>;
  continueSearchCollections(
    next: string,
    options?: ContinuationOptions & { representation?: "terse" }
  ): CollectionSequence<TerseCollection>;
  continueSearchCollections(
    next: string,
    options: ContinuationOptions & { representation: "full" }
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
  continueListOfferings(
    next: string,
    options?: ContinuationOptions & { representation?: "terse" }
  ): CollectionSequence<TerseOffering>;
  continueListOfferings(
    next: string,
    options: ContinuationOptions & { representation: "full" }
  ): CollectionSequence<Offering>;
  continueSearchOfferings(
    next: string,
    options?: ContinuationOptions & { representation?: "terse" }
  ): CollectionSequence<TerseOffering>;
  continueSearchOfferings(
    next: string,
    options: ContinuationOptions & { representation: "full" }
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
  const transport = options.transport ?? createDefaultTransport(options.allowLocalNetwork);
  const inspectionTransport = options.inspectionTransport ?? transport;
  const supportingTransport =
    options.supportingTransport ?? createDefaultTransport(options.allowLocalNetwork);
  const cache = options.cache ?? createInMemoryOdpCache();
  if (options.cachePartition !== undefined && options.cachePartition.length === 0)
    throw new RangeError("cachePartition must not be empty");
  const catalogCache =
    options.transport === undefined || options.cachePartition !== undefined ? cache : undefined;
  const cachePartition = options.cachePartition ?? "public";
  // When the shared cache is disabled — a caller-supplied transport with no declared partition,
  // whose authentication context this client cannot know — the Service Document still gets a cache,
  // but a private one, so it is reused without ever being visible to another client (CCH-05).
  const inspectionCache = catalogCache ?? createInMemoryOdpCache();
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
  // `signal` is inherited from InspectServiceOptions and used to apply to inspection alone, which
  // silently ignored it for every catalog, schema and OpenAPI request.
  const scoped = (signal?: AbortSignal): AbortSignal | undefined => {
    if (options.signal === undefined) return signal;
    if (signal === undefined) return options.signal;
    return AbortSignal.any([options.signal, signal]);
  };
  let inspectionFlight: Promise<ServiceInspection> | undefined;
  const inspect = (signal?: AbortSignal): Promise<ServiceInspection> => {
    // The Service Document used to be cached under the unpartitioned `cache` even when the
    // catalog cache was deliberately disabled, so an authenticated document could be read back by
    // an anonymous client sharing the cache (CCH-05, CCH-06).
    const base = {
      serviceUrl: options.serviceUrl,
      fetch: inspectionTransport,
      ...(options.acceptLanguage === undefined ? {} : { acceptLanguage: options.acceptLanguage }),
      cache: inspectionCache,
      cachePartition,
      fallbackTtlMs: fallbacks.serviceDocumentMs,
      ...(options.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects })
    };
    const combined = scoped(signal);
    if (signal !== undefined)
      return inspectService({
        ...base,
        ...(combined === undefined ? {} : { signal: combined })
      });
    inspectionFlight ??= inspectService({
      ...base,
      ...(combined === undefined ? {} : { signal: combined })
    }).finally(() => {
      inspectionFlight = undefined;
    });
    return inspectionFlight;
  };

  const sequence = <Item>(
    operation: "list-collections" | "search-collections",
    input: CollectionListOptions | CollectionSearchOptions,
    body?: CollectionSearchRequest,
    next?: string
  ): CollectionSequence<Item> => {
    const request = withScopedSignal(input, scoped(input.signal));
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
        body,
        next
      );
    return {
      pages: { [Symbol.asyncIterator]: pages },
      items: itemIterable(pages, request.maxItems)
    };
  };

  const offeringSequence = <Item>(
    operation: "list-offerings" | "list-collection-offerings" | "search-offerings",
    input: OfferingListOptions | OfferingSearchOptions,
    collectionId?: string,
    body?: OfferingSearchRequest,
    next?: string
  ): CollectionSequence<Item> => {
    const request = withScopedSignal(input, scoped(input.signal));
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
        body,
        next
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

  function continueListOfferings(
    next: string,
    request?: ContinuationOptions & { representation?: "terse" }
  ): CollectionSequence<TerseOffering>;
  function continueListOfferings(
    next: string,
    request: ContinuationOptions & { representation: "full" }
  ): CollectionSequence<Offering>;
  function continueListOfferings(
    next: string,
    request: ContinuationOptions = {}
  ): CollectionSequence<TerseOffering> | CollectionSequence<Offering> {
    return request.representation === "full"
      ? offeringSequence<Offering>("list-offerings", request, undefined, undefined, next)
      : offeringSequence<TerseOffering>("list-offerings", request, undefined, undefined, next);
  }

  function continueSearchOfferings(
    next: string,
    request?: ContinuationOptions & { representation?: "terse" }
  ): CollectionSequence<TerseOffering>;
  function continueSearchOfferings(
    next: string,
    request: ContinuationOptions & { representation: "full" }
  ): CollectionSequence<Offering>;
  function continueSearchOfferings(
    next: string,
    request: ContinuationOptions = {}
  ): CollectionSequence<TerseOffering> | CollectionSequence<Offering> {
    return request.representation === "full"
      ? offeringSequence<Offering>("search-offerings", request, undefined, undefined, next)
      : offeringSequence<TerseOffering>("search-offerings", request, undefined, undefined, next);
  }

  async function getCollection(
    id: string,
    request: CollectionGetOptions = {}
  ): Promise<Collection> {
    const signal = scoped(request.signal);
    const inspected = requireOperation(await inspect(signal), "get-collection");
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
      requestInit("GET", signal),
      options.acceptLanguage,
      catalogCache,
      cachePartition,
      "collection",
      fallbacks.collectionMs,
      parseAgentCollection
    );
    const collection = parseAgentCollection(value);
    requireCollectionRepresentation(collection, request.representation ?? "full");
    requireResourceId(collection.id, id, "Collection");
    return collection;
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
    const signal = scoped(request.signal);
    const { offering, serviceOpenApiUrl, url } = await getOfferingWire(id, request);
    // `getOfferingWire` has already asserted the representation. This is a Top-Level Document, not
    // an item nested in a page, so it legitimately carries `odp_version` (VER-01 rather than
    // VER-03) and must not go through the nested-item parser.
    if (request.representation === "terse") return offering as TerseOffering;
    return enrichOffering(offering, url, serviceOpenApiUrl, signal);
  }

  async function getOfferingWire(
    id: string,
    request: OfferingGetOptions
  ): Promise<{ offering: Offering; serviceOpenApiUrl?: string; url: URL }> {
    const signal = scoped(request.signal);
    const inspected = requireOperation(await inspect(signal), "get-offering");
    const url = buildOdpOperationUrl(
      inspected.document.http.endpoint_base,
      "get-offering",
      inspected.serviceOrigin,
      id
    );
    addRepresentation(url, request.representation);
    const offering = parseAgentOffering(
      await requestOdpValue(
        transport,
        url,
        requestInit("GET", signal),
        options.acceptLanguage,
        catalogCache,
        cachePartition,
        "offering",
        fallbacks.offeringMs,
        parseAgentOffering
      )
    );
    requireOfferingRepresentation(offering, request.representation ?? "full");
    requireResourceId(offering.id, id, "Offering");
    return {
      offering,
      ...(inspected.document.http.openapi?.url === undefined
        ? {}
        : { serviceOpenApiUrl: inspected.document.http.openapi.url }),
      url
    };
  }

  async function enrichOffering(
    offering: Offering,
    offeringUrl: URL,
    serviceOpenApiUrl?: string,
    signal?: AbortSignal
  ): Promise<OfferingDetails> {
    const { actions: wireActions, attributes, ...envelope } = offering;
    const normalized = normalizeActions(wireActions, offeringUrl.origin, serviceOpenApiUrl);
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
    continueListCollections(next, request = {}) {
      return sequence("list-collections", request, undefined, next);
    },
    continueSearchCollections(next, request = {}) {
      return sequence("search-collections", request, undefined, next);
    },
    getCollection,
    async getCollectionSearchCapabilities(id, request = {}) {
      const signal = scoped(request.signal);
      const inspected = await inspect(signal);
      const collection = await getCollection(id, {
        representation: "full",
        ...(signal === undefined ? {} : { signal })
      });
      return resolveCapabilities(inspected, collection.search_capabilities, signal);
    },
    listOfferings,
    listCollectionOfferings,
    searchOfferings,
    continueListOfferings,
    continueSearchOfferings,
    getOffering,
    async resolveAction(offeringId, actionId, request = {}) {
      const signal = scoped(request.signal);
      const { offering, serviceOpenApiUrl, url } = await getOfferingWire(offeringId, {
        representation: "full",
        ...(signal === undefined ? {} : { signal })
      });
      const normalized = normalizeActions(offering.actions, url.origin, serviceOpenApiUrl);
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
          ...(signal === undefined ? {} : { signal })
        });
        return { action: httpAction, request_schema: resolved.schema };
      }
      const openApiAction = { ...action, target: action.target };
      const resolved = await resolveOpenApiOperation({
        url: new URL(action.target.url),
        operationId: action.target.operation_id,
        transport: supportingTransport,
        cache,
        ...(signal === undefined ? {} : { signal })
      });
      return {
        action: openApiAction,
        openapi_document: resolved.document,
        operation: resolved.operation
      };
    },
    async getOfferingSearchCapabilities(collectionId, request = {}) {
      const signal = scoped(request.signal);
      const inspected = await inspect(signal);
      const collection =
        collectionId === undefined
          ? undefined
          : await getCollection(collectionId, {
              representation: "full",
              ...(signal === undefined ? {} : { signal })
            });
      return resolveCapabilities(inspected, collection?.search_capabilities, signal);
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
        const parser = kind === "filters" ? parseAgentFilterPage : parseAgentSortPage;
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
  body?: CollectionSearchRequest,
  continuation?: string
): AsyncGenerator<PageEnvelope<Item>> {
  const inspection = await inspect(request.signal);
  const inspected =
    continuation === undefined ? requireOperation(inspection, operation) : inspection;
  const url =
    continuation === undefined
      ? buildOdpOperationUrl(
          inspected.document.http.endpoint_base,
          operation,
          inspected.serviceOrigin
        )
      : resolveContinuation(continuation, inspected.serviceOrigin);
  let init: RequestInit;
  if (continuation === undefined) {
    addRepresentation(url, request.representation);
    const limit = request.limit ?? defaultLimit;
    requireLimit(limit, "limit");
    init =
      operation === "search-collections"
        ? { ...requestInit("POST", request.signal), body: JSON.stringify({ ...body, limit }) }
        : requestInit("GET", request.signal);
    if (operation === "list-collections") url.searchParams.set("limit", String(limit));
  } else {
    init = requestInit("GET", request.signal);
  }
  const maximum = request.maxPages;
  if (maximum !== undefined) requirePageLimit(maximum);
  const strictness = itemStrictness(request.representation, continuation);
  const visited = new Set<string>([String(url)]);
  let current = url;
  for (let count = 0; ; count += 1) {
    const raw = parseAgentCollectionPage(
      await requestOdpValue(
        transport,
        current,
        init,
        acceptLanguage,
        cache,
        cachePartition,
        operation === "search-collections" ? "search" : "collection",
        operation === "search-collections" ? fallbacks.searchMs : fallbacks.collectionMs,
        parseAgentCollectionPage
      )
    );
    requirePageSize(raw.items);
    const page = {
      ...raw,
      items: raw.items.map((item) => parseCollectionItem(item, raw.odp_version, strictness))
    } as PageEnvelope<Item>;
    yield page;
    if (page.next === undefined) return;
    if (maximum !== undefined && count + 1 >= maximum) return;
    const next = resolveContinuation(page.next, inspected.serviceOrigin);
    // Compare resolved URLs: a Service alternating between the relative and absolute spelling of
    // one link would slip past a raw-string comparison (PAG-11).
    if (visited.has(String(next))) throw new Error("ODP pagination loop detected");
    visited.add(String(next));
    current = next;
    init = requestInit("GET", request.signal);
  }
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
  body?: OfferingSearchRequest,
  continuation?: string
): AsyncGenerator<OfferingPage<Item>> {
  const inspection = await inspect(request.signal);
  const inspected =
    continuation === undefined ? requireOperation(inspection, operation) : inspection;
  const url =
    continuation === undefined
      ? buildOdpOperationUrl(
          inspected.document.http.endpoint_base,
          operation,
          inspected.serviceOrigin,
          collectionId
        )
      : resolveContinuation(continuation, inspected.serviceOrigin);
  let init: RequestInit;
  if (continuation === undefined) {
    addRepresentation(url, request.representation);
    const limit = request.limit ?? defaultLimit;
    requireLimit(limit, "limit");
    init =
      operation === "search-offerings"
        ? { ...requestInit("POST", request.signal), body: JSON.stringify({ ...body, limit }) }
        : requestInit("GET", request.signal);
    if (operation !== "search-offerings") url.searchParams.set("limit", String(limit));
  } else {
    init = requestInit("GET", request.signal);
  }
  const maximum = request.maxPages;
  if (maximum !== undefined) requirePageLimit(maximum);
  const strictness = itemStrictness(request.representation, continuation);
  const requestedRefinements = body?.refinements;
  const visited = new Set<string>([String(url)]);
  let current = url;
  for (let count = 0; ; count += 1) {
    const parser =
      operation === "search-offerings" ? parseAgentOfferingSearchResponse : parseAgentOfferingPage;
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
    requirePageSize(raw.items);
    if (continuation !== undefined || count > 0) {
      // OFR-15: only the initial response of a search may carry refinements.
      if (raw.refinements !== undefined)
        throw new TypeError("ODP Offering search continuation cannot contain refinements");
    } else requireRequestedRefinements(raw.refinements, requestedRefinements);
    const page = {
      ...raw,
      items: raw.items.map((item) => parseOfferingItem(item, raw.odp_version, strictness))
    } as OfferingPage<Item>;
    yield page;
    if (page.next === undefined) return;
    if (maximum !== undefined && count + 1 >= maximum) return;
    const next = resolveContinuation(page.next, inspected.serviceOrigin);
    if (visited.has(String(next))) throw new Error("ODP pagination loop detected");
    visited.add(String(next));
    current = next;
    init = requestInit("GET", request.signal);
  }
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
          count += 1;
          yield item;
          // PAG-30: stop the moment the caller's limit is met. Checking on the *next* item instead
          // let the enclosing `for await` pull one more page whenever the limit fell on a page
          // boundary — a request the caller never asked for.
          if (maximum !== undefined && count >= maximum) return;
        }
      }
    }
  };
}

/** Returns `request` with the client-wide signal folded in, without mutating the caller's object. */
function withScopedSignal<Request extends { signal?: AbortSignal }>(
  request: Request,
  signal: AbortSignal | undefined
): Request {
  if (signal === request.signal) return request;
  return { ...request, ...(signal === undefined ? {} : { signal }) };
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
  if (!inspection.capabilities.operations.some(({ name }) => name === operation))
    throw new Error(`ODP Service does not advertise ${operation}`);
  return inspection;
}

function parseAgentCollection(value: unknown): Collection {
  return parseCollection(normalizeAgentResponse(value, "collection"));
}

function parseAgentOffering(value: unknown): Offering {
  return parseOffering(normalizeAgentResponse(value, "offering"));
}

function parseAgentCollectionPage(value: unknown): PageEnvelope {
  return parsePage(normalizeAgentResponse(value, "collection-page"));
}

function parseAgentOfferingPage(value: unknown): PageEnvelope {
  return parsePage(normalizeAgentResponse(value, "offering-page"));
}

function parseAgentOfferingSearchResponse(value: unknown): OfferingPage {
  return parseOfferingSearchResponse(normalizeAgentResponse(value, "offering-page"));
}

function parseAgentFilterPage(value: unknown): PageEnvelope<FilterDefinition> {
  return parseFilterDefinitionPage(normalizeAgentResponse(value, "filter-page"));
}

function parseAgentSortPage(value: unknown): PageEnvelope<SortDefinition> {
  return parseSortDefinitionPage(normalizeAgentResponse(value, "sort-page"));
}

/**
 * VER-03: a nested item inherits its container's version and must not restate `odp_version`.
 * Spreading the item over an injected version would have accepted — and silently discarded — a
 * repeated one.
 */
function requireInheritedVersion(value: object): void {
  if ("odp_version" in value) throw new TypeError("ODP terse item cannot repeat odp_version");
}

/**
 * `full` is `undefined` on a continuation the caller did not label: the representation was fixed by
 * the request that produced the continuation link, which this call cannot see, so neither shape may
 * be asserted (PAG-37).
 */
function parseOfferingItem(value: unknown, version: "1.0", full: true): Offering;
function parseOfferingItem(value: unknown, version: "1.0", full: false): TerseOffering;
function parseOfferingItem(
  value: unknown,
  version: "1.0",
  full: boolean | undefined
): Offering | TerseOffering;
function parseOfferingItem(
  value: unknown,
  version: "1.0",
  full: boolean | undefined
): Offering | TerseOffering {
  if (typeof value !== "object" || value === null) return parseAgentOffering(value);
  requireInheritedVersion(value);
  const parsed = parseAgentOffering({ odp_version: version, ...value });
  if (full === undefined) return structuredClone(value) as TerseOffering;
  requireOfferingRepresentation(parsed, full ? "full" : "terse");
  if (full) return parsed;
  return structuredClone(value) as TerseOffering;
}

function parseCollectionItem(
  value: unknown,
  version: "1.0",
  full: boolean | undefined
): Collection | TerseCollection {
  if (typeof value !== "object" || value === null) return parseAgentCollection(value);
  requireInheritedVersion(value);
  const parsed = parseAgentCollection({ odp_version: version, ...value });
  if (full === undefined) return structuredClone(value) as TerseCollection;
  requireCollectionRepresentation(parsed, full ? "full" : "terse");
  if (full) return parsed;
  return structuredClone(value) as TerseCollection;
}

function requireOfferingRepresentation(offering: Offering, representation: Representation): void {
  if (representation === "terse" && "actions" in offering)
    throw new TypeError("ODP Terse Offering cannot contain actions");
  if (representation === "full" && "detail_fields" in offering)
    throw new TypeError("ODP Full Offering cannot contain detail_fields");
}

function requireCollectionRepresentation(
  collection: Collection,
  representation: Representation
): void {
  if (representation === "full" && "detail_fields" in collection)
    throw new TypeError("ODP Full Collection cannot contain detail_fields");
}

/**
 * `undefined` means "do not assert a representation": on a continuation the caller did not label,
 * the shape was fixed by the request that produced the link and is not knowable here (PAG-37).
 */
function itemStrictness(
  representation: Representation | undefined,
  continuation: string | undefined
): boolean | undefined {
  if (representation !== undefined) return representation === "full";
  return continuation === undefined ? false : undefined;
}

/**
 * OFR-14 and FLT-30: a search response may carry `refinements` only when the request asked for
 * them, every returned `filter_id` must have been requested, and no group may repeat.
 */
function requireRequestedRefinements(
  groups: { filter_id: string }[] | undefined,
  requested: string[] | undefined
): void {
  if (groups === undefined) return;
  if (requested === undefined)
    throw new TypeError("ODP Offering search returned refinements that were not requested");
  const allowed = new Set(requested);
  const seen = new Set<string>();
  for (const group of groups) {
    if (!allowed.has(group.filter_id))
      throw new TypeError(
        `ODP Offering search returned refinement ${group.filter_id} that was not requested`
      );
    if (seen.has(group.filter_id))
      throw new TypeError(`ODP Offering search repeated refinement group ${group.filter_id}`);
    seen.add(group.filter_id);
  }
}

function requirePageSize(items: unknown[]): void {
  if (items.length > 100) throw new RangeError("ODP page cannot contain more than 100 items");
}

function addRepresentation(url: URL, representation?: Representation): void {
  if (representation !== undefined) url.searchParams.set("representation", representation);
}

function requireLimit(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 100)
    throw new RangeError(`${name} must be an integer from 1 through 100`);
}

function requirePageLimit(value: number): void {
  if (!Number.isInteger(value) || value < 1)
    throw new RangeError("maxPages must be a positive integer");
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
