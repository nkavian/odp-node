import { Buffer } from "node:buffer";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

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
  target: string;
  representation: string;
}

export function createStaticCatalog(options: StaticCatalogOptions): OdpCatalog {
  const offerings = cloneUnique(options.offerings.map(parseOffering), "Offering");
  const collections = cloneUnique((options.collections ?? []).map(parseCollection), "Collection");
  const offeringById = new Map(offerings.map((offering) => [offering.id, offering]));
  const collectionById = new Map(collections.map((collection) => [collection.id, collection]));
  validateRelationships(offerings, collections, collectionById);
  const continuationKey = randomBytes(32);

  return {
    listOfferings: (request) => page(offerings, request, terseOffering, continuationKey),
    getOffering: (id, request) => represent(offeringById.get(id), request, terseOffering),
    ...(collections.length === 0
      ? {}
      : {
          listCollections: (request: OdpCatalogRequest) =>
            page(collections, request, terseCollection, continuationKey),
          getCollection: (id: string, request: OdpCatalogRequest) =>
            represent(collectionById.get(id), request, terseCollection),
          listCollectionOfferings: (id: string, request: OdpCatalogRequest) => {
            if (!collectionById.has(id))
              throw new OdpServiceError(404, "NOT_FOUND", "Collection not found");
            return page(
              offerings.filter(({ collection_ids: ids }) => ids?.includes(id) === true),
              request,
              terseOffering,
              continuationKey
            );
          }
        })
  };
}

function page<Full, Terse>(
  values: Full[],
  request: OdpCatalogRequest,
  terse: (value: Full) => Terse,
  continuationKey: Uint8Array
): PageEnvelope<Full | Terse> {
  const limit = request.limit ?? 50;
  const offset = consumeCursor(request, limit, continuationKey);
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
            continuationKey,
            request.request
          )
        })
  };
}

function continuation(
  offset: number,
  representation: string,
  limit: number,
  continuationKey: Uint8Array,
  request: Request
): string {
  const state: StaticContinuation = {
    expiresAt: Date.now() + 3_600_000,
    limit,
    offset,
    target: requestTarget(request),
    representation
  };
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  const signature = createHmac("sha256", continuationKey).update(payload).digest("base64url");
  const cursor = `${payload}.${signature}`;
  const query = new URLSearchParams({
    cursor,
    representation,
    limit: String(limit)
  });
  return `${new URL(request.url).pathname}?${query.toString()}`;
}

function represent<Full, Terse extends object>(
  value: Full | undefined,
  request: OdpCatalogRequest,
  terse: (value: Full) => Terse
): Full | Terse | undefined {
  if (value === undefined) return undefined;
  return request.representation === "full"
    ? structuredClone(value)
    : { odp_version: "1.0" as const, ...terse(value) };
}

function terseOffering(offering: Offering): TerseOffering {
  return structuredClone({
    ...(offering.auth_expands === undefined ? {} : { auth_expands: offering.auth_expands }),
    id: offering.id,
    name: offering.name,
    ...(offering.description === undefined ? {} : { description: offering.description }),
    ...(offering.images === undefined ? {} : { images: offering.images.slice(0, 1) }),
    ...(offering.language === undefined ? {} : { language: offering.language }),
    ...(offering.localizations === undefined ? {} : { localizations: offering.localizations }),
    ...(offering.web_url === undefined ? {} : { web_url: offering.web_url }),
    ...(offering.collection_ids === undefined ? {} : { collection_ids: offering.collection_ids }),
    ...(offering.price === undefined ? {} : { price: offering.price })
  });
}

function terseCollection(collection: Collection): TerseCollection {
  return structuredClone({
    ...(collection.auth_expands === undefined ? {} : { auth_expands: collection.auth_expands }),
    id: collection.id,
    name: collection.name,
    ...(collection.description === undefined ? {} : { description: collection.description }),
    ...(collection.images === undefined ? {} : { images: collection.images.slice(0, 1) }),
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

function validateRelationships(
  offerings: Offering[],
  collections: Collection[],
  collectionById: ReadonlyMap<string, Collection>
): void {
  for (const offering of offerings)
    for (const id of offering.collection_ids ?? [])
      if (!collectionById.has(id))
        throw new TypeError(`Offering ${offering.id} references unknown Collection ${id}`);

  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (collection: Collection): number => {
    const known = depths.get(collection.id);
    if (known !== undefined) return known;
    if (visiting.has(collection.id)) throw new TypeError("Collection hierarchy must be acyclic");
    visiting.add(collection.id);
    let maximum = 0;
    for (const id of collection.parent_ids ?? []) {
      const parent = collectionById.get(id);
      if (parent === undefined)
        throw new TypeError(`Collection ${collection.id} references unknown parent ${id}`);
      maximum = Math.max(maximum, depth(parent) + 1);
    }
    visiting.delete(collection.id);
    if (maximum > 32) throw new TypeError("Collection hierarchy exceeds 32 edges");
    depths.set(collection.id, maximum);
    return maximum;
  };
  for (const collection of collections) depth(collection);
}

function consumeCursor(
  request: OdpCatalogRequest,
  limit: number,
  continuationKey: Uint8Array
): number {
  const { cursor } = request;
  if (cursor === undefined) return 0;
  const continuation = decodeContinuation(cursor, continuationKey);
  if (continuation === undefined || continuation.expiresAt < Date.now()) {
    throw new OdpServiceError(410, "CONTINUATION_EXPIRED", "Continuation is unavailable");
  }
  if (continuation.limit !== limit || continuation.representation !== request.representation)
    throw new OdpServiceError(400, "INVALID_REQUEST", "Continuation context changed");
  if (continuation.target !== requestTarget(request.request))
    throw new OdpServiceError(400, "INVALID_REQUEST", "Continuation context changed");
  return continuation.offset;
}

function decodeContinuation(
  cursor: string,
  continuationKey: Uint8Array
): StaticContinuation | undefined {
  const [payload, encodedSignature, extra] = cursor.split(".");
  if (payload === undefined || encodedSignature === undefined || extra !== undefined)
    return undefined;
  const signature = Buffer.from(encodedSignature, "base64url");
  const expected = createHmac("sha256", continuationKey).update(payload).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected))
    return undefined;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const state = value as Partial<StaticContinuation>;
    if (
      !Number.isSafeInteger(state.expiresAt) ||
      !Number.isInteger(state.limit) ||
      !Number.isInteger(state.offset) ||
      typeof state.target !== "string" ||
      (state.representation !== "terse" && state.representation !== "full")
    )
      return undefined;
    return state as StaticContinuation;
  } catch {
    return undefined;
  }
}

function requestTarget(request: Request): string {
  const url = new URL(request.url);
  return `${url.origin}${url.pathname}`;
}
