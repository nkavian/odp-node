import { randomUUID } from "node:crypto";

import {
  parseCollection,
  parseOffering,
  type Collection,
  type Offering,
  type PageEnvelope,
  type TerseCollection,
  type TerseOffering
} from "@offering-protocol/core";

import { OdpServiceError, type OdpCatalog, type OdpCatalogRequest } from "./service.js";

export interface StaticCatalogOptions {
  collections?: Collection[];
  offerings: Offering[];
}

interface StaticContinuation {
  expiresAt: number;
  limit: number;
  offset: number;
  representation: string;
}

export function createStaticCatalog(options: StaticCatalogOptions): OdpCatalog {
  const offerings = cloneUnique(options.offerings.map(parseOffering), "Offering");
  const collections = cloneUnique((options.collections ?? []).map(parseCollection), "Collection");
  const offeringById = new Map(offerings.map((offering) => [offering.id, offering]));
  const collectionById = new Map(collections.map((collection) => [collection.id, collection]));
  const continuations = new Map<string, StaticContinuation>();

  return {
    listOfferings: (request) => page(offerings, request, terseOffering, continuations),
    getOffering: (id, request) => represent(offeringById.get(id), request, terseOffering),
    ...(collections.length === 0
      ? {}
      : {
          listCollections: (request: OdpCatalogRequest) =>
            page(collections, request, terseCollection, continuations),
          getCollection: (id: string, request: OdpCatalogRequest) =>
            represent(collectionById.get(id), request, terseCollection),
          listCollectionOfferings: (id: string, request: OdpCatalogRequest) => {
            if (!collectionById.has(id))
              throw new OdpServiceError(404, "NOT_FOUND", "Collection not found");
            return page(
              offerings.filter(({ collection_ids: ids }) => ids?.includes(id) === true),
              request,
              terseOffering,
              continuations
            );
          }
        })
  };
}

function page<Full, Terse>(
  values: Full[],
  request: OdpCatalogRequest,
  terse: (value: Full) => Terse,
  continuations: Map<string, StaticContinuation>
): PageEnvelope<Full | Terse> {
  const limit = request.limit ?? 50;
  const offset = consumeCursor(request, limit, continuations);
  const items = values
    .slice(offset, offset + limit)
    .map((value) => (request.representation === "full" ? structuredClone(value) : terse(value)));
  const nextOffset = offset + items.length;
  return {
    odp_version: "1.0",
    items,
    ...(nextOffset >= values.length
      ? {}
      : {
          next: continuation(
            nextOffset,
            request.representation,
            limit,
            continuations,
            request.request
          )
        })
  };
}

function continuation(
  offset: number,
  representation: string,
  limit: number,
  continuations: Map<string, StaticContinuation>,
  request: Request
): string {
  pruneContinuations(continuations);
  const cursor = randomUUID();
  continuations.set(cursor, {
    expiresAt: Date.now() + 3_600_000,
    limit,
    offset,
    representation
  });
  const query = new URLSearchParams({
    cursor,
    representation,
    limit: String(limit)
  });
  return `${new URL(request.url).pathname}?${query.toString()}`;
}

function represent<Full, Terse>(
  value: Full | undefined,
  request: OdpCatalogRequest,
  terse: (value: Full) => Terse
): Full | Terse | undefined {
  if (value === undefined) return undefined;
  return request.representation === "full" ? structuredClone(value) : terse(value);
}

function terseOffering(offering: Offering): TerseOffering {
  return structuredClone({
    id: offering.id,
    name: offering.name,
    ...(offering.description === undefined ? {} : { description: offering.description }),
    ...(offering.language === undefined ? {} : { language: offering.language }),
    ...(offering.localizations === undefined ? {} : { localizations: offering.localizations }),
    ...(offering.web_url === undefined ? {} : { web_url: offering.web_url }),
    ...(offering.collection_ids === undefined ? {} : { collection_ids: offering.collection_ids }),
    ...(offering.price === undefined ? {} : { price: offering.price })
  });
}

function terseCollection(collection: Collection): TerseCollection {
  return structuredClone({
    id: collection.id,
    name: collection.name,
    ...(collection.description === undefined ? {} : { description: collection.description }),
    ...(collection.language === undefined ? {} : { language: collection.language }),
    ...(collection.localizations === undefined ? {} : { localizations: collection.localizations }),
    ...(collection.parent_ids === undefined ? {} : { parent_ids: collection.parent_ids }),
    ...(collection.web_url === undefined ? {} : { web_url: collection.web_url })
  });
}

function cloneUnique<Value extends { id: string }>(values: Value[], name: string): Value[] {
  const copy = structuredClone(values);
  if (new Set(copy.map(({ id }) => id)).size !== copy.length)
    throw new TypeError(`${name} identifiers must be unique`);
  return copy;
}

function consumeCursor(
  request: OdpCatalogRequest,
  limit: number,
  continuations: Map<string, StaticContinuation>
): number {
  const { cursor } = request;
  if (cursor === undefined) return 0;
  const continuation = continuations.get(cursor);
  if (continuation === undefined || continuation.expiresAt < Date.now()) {
    continuations.delete(cursor);
    throw new OdpServiceError(410, "CONTINUATION_EXPIRED", "Continuation is unavailable");
  }
  if (continuation.limit !== limit || continuation.representation !== request.representation)
    throw new OdpServiceError(400, "INVALID_REQUEST", "Continuation context changed");
  return continuation.offset;
}

function pruneContinuations(continuations: Map<string, StaticContinuation>): void {
  const now = Date.now();
  for (const [cursor, continuation] of continuations)
    if (continuation.expiresAt < now) continuations.delete(cursor);
}
