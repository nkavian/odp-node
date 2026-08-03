import {
  parseCollection,
  parseCollectionSearchRequest,
  isLocalResourceIdentifier,
  OdpValidationError,
  parseOffering,
  parseOfferingSearchRequest,
  parseServiceDocument,
  type Collection,
  type CollectionSearchRequest,
  type Offering,
  type OfferingPage,
  type OfferingSearchRequest,
  type OdpOperation,
  type PageEnvelope,
  type Representation,
  type ServiceDocument,
  type TerseCollection,
  type TerseOffering
} from "@offering-protocol/core";

export type Awaitable<Value> = Value | Promise<Value>;
export type OdpResponseHeaders = Headers | Readonly<Record<string, string>>;

export interface OdpCatalogRequest {
  cursor?: string;
  language?: string;
  limit?: number;
  representation: Representation;
  request: Request;
}

export interface OdpCatalog {
  listOfferings: (request: OdpCatalogRequest) => Awaitable<PageEnvelope<Offering | TerseOffering>>;
  getOffering: (
    id: string,
    request: OdpCatalogRequest
  ) => Awaitable<Offering | TerseOffering | undefined>;
  listCollections?: (
    request: OdpCatalogRequest
  ) => Awaitable<PageEnvelope<Collection | TerseCollection>>;
  searchCollections?: (
    query: CollectionSearchRequest | undefined,
    request: OdpCatalogRequest
  ) => Awaitable<PageEnvelope<Collection | TerseCollection>>;
  getCollection?: (
    id: string,
    request: OdpCatalogRequest
  ) => Awaitable<Collection | TerseCollection | undefined>;
  listCollectionOfferings?: (
    collectionId: string,
    request: OdpCatalogRequest
  ) => Awaitable<PageEnvelope<Offering | TerseOffering>>;
  searchOfferings?: (
    query: OfferingSearchRequest | undefined,
    request: OdpCatalogRequest
  ) => Awaitable<OfferingPage<Offering | TerseOffering>>;
}

export interface OdpServiceDocumentConfig extends Omit<
  ServiceDocument,
  "odp_version" | "operations"
> {
  odp_version?: "1.0";
}

export interface OdpServiceOptions {
  catalog: OdpCatalog;
  document: OdpServiceDocumentConfig;
}

export interface OdpService {
  readonly document: ServiceDocument;
  fetch(request: Request): Promise<Response>;
}

export class OdpServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers?: OdpResponseHeaders
  ) {
    super(message);
    this.name = "OdpServiceError";
  }
}

const MEDIA_TYPE = "application/odp+json";
const PROBLEM_TYPE = "application/problem+json";
const MAXIMUM_REQUEST_BYTES = 65_536;
const OPTIONAL_OPERATIONS = [
  "list-collections",
  "search-collections",
  "get-collection",
  "list-collection-offerings",
  "search-offerings"
] as const;

export function createOdpService(options: OdpServiceOptions): OdpService {
  requireBaseline(options.catalog);
  const operations: OdpOperation[] = ["list-offerings", "get-offering"];
  for (const operation of OPTIONAL_OPERATIONS)
    if (handlerFor(options.catalog, operation) !== undefined) operations.push(operation);
  operations.sort();
  const document = parseServiceDocument({
    ...options.document,
    odp_version: "1.0",
    operations: { supported: operations }
  });
  const endpointBase = normalizeBase(document.http.endpoint_base);

  return {
    document: structuredClone(document),
    async fetch(request) {
      try {
        return await route(request);
      } catch (error) {
        if (error instanceof OdpServiceError)
          return problem(error.status, error.code, error.message, error.headers);
        return problem(500, "INTERNAL_ERROR", "The ODP Service could not complete the request");
      }
    }
  };

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    requireAccept(request);
    if (url.pathname === "/.well-known/odp") {
      requireMethod(request, "GET");
      return json(document, document.language);
    }
    if (!url.pathname.startsWith(`${endpointBase}/`))
      throw new RequestProblem(404, "NOT_FOUND", "ODP resource not found");
    const path = url.pathname.slice(endpointBase.length);
    if (path === "/offerings") {
      requireMethod(request, "GET");
      const input = catalogRequest(request, url, "terse");
      const page = validateOfferingPage(await options.catalog.listOfferings(input), input);
      return json(page, responseLanguage(page, document.language));
    }
    if (path === "/offerings/search") {
      const handler = requireHandler(options.catalog.searchOfferings, "search-offerings");
      const input = catalogRequest(request, url, "terse");
      if (request.method === "GET") {
        requireCursor(input);
        const page = validateOfferingPage(await handler(undefined, input), input);
        return json(page, responseLanguage(page, document.language));
      }
      requireMethod(request, "POST");
      const query = parseRequest(parseOfferingSearchRequest, await requestBody(request));
      const searchInput = withLimit(input, query.limit);
      const page = validateOfferingPage(await handler(query, searchInput), searchInput);
      return json(page, responseLanguage(page, document.language));
    }
    const offeringId = resourceId(path, "/offerings/");
    if (offeringId !== undefined) {
      requireMethod(request, "GET");
      const input = catalogRequest(request, url, "full");
      const offering = await options.catalog.getOffering(offeringId, input);
      if (offering === undefined) throw new RequestProblem(404, "NOT_FOUND", "Offering not found");
      const validated = validateOffering(offering, input.representation);
      requireResourceId(validated.id, offeringId, "Offering");
      return json(validated, responseLanguage(validated, document.language));
    }
    if (path === "/collections") {
      requireMethod(request, "GET");
      const input = catalogRequest(request, url, "terse");
      const handler = requireHandler(options.catalog.listCollections, "list-collections");
      const page = validateCollectionPage(await handler(input), input.representation);
      return json(page, responseLanguage(page, document.language));
    }
    if (path === "/collections/search") {
      const handler = requireHandler(options.catalog.searchCollections, "search-collections");
      const input = catalogRequest(request, url, "terse");
      if (request.method === "GET") {
        requireCursor(input);
        const page = validateCollectionPage(await handler(undefined, input), input.representation);
        return json(page, responseLanguage(page, document.language));
      }
      requireMethod(request, "POST");
      const query = parseRequest(parseCollectionSearchRequest, await requestBody(request));
      const searchInput = withLimit(input, query.limit);
      const page = validateCollectionPage(await handler(query, searchInput), input.representation);
      return json(page, responseLanguage(page, document.language));
    }
    const collectionOfferings = collectionOfferingId(path);
    if (collectionOfferings !== undefined) {
      requireMethod(request, "GET");
      const input = catalogRequest(request, url, "terse");
      const handler = requireHandler(
        options.catalog.listCollectionOfferings,
        "list-collection-offerings"
      );
      const page = validateOfferingPage(await handler(collectionOfferings, input), input);
      return json(page, responseLanguage(page, document.language));
    }
    const collectionId = resourceId(path, "/collections/");
    if (collectionId !== undefined) {
      requireMethod(request, "GET");
      const input = catalogRequest(request, url, "full");
      const handler = requireHandler(options.catalog.getCollection, "get-collection");
      const collection = await handler(collectionId, input);
      if (collection === undefined)
        throw new RequestProblem(404, "NOT_FOUND", "Collection not found");
      const validated = validateCollection(collection, input.representation);
      requireResourceId(validated.id, collectionId, "Collection");
      return json(validated, responseLanguage(validated, document.language));
    }
    throw new RequestProblem(404, "NOT_FOUND", "ODP resource not found");
  }
}

function catalogRequest(
  request: Request,
  url: URL,
  defaultRepresentation: Representation
): OdpCatalogRequest {
  if (url.searchParams.getAll("representation").length > 1)
    throw new RequestProblem(400, "INVALID_REQUEST", "representation must not be repeated");
  const representation = url.searchParams.get("representation") ?? defaultRepresentation;
  if (representation !== "terse" && representation !== "full")
    throw new RequestProblem(400, "INVALID_REQUEST", "representation must be terse or full");
  const limitValue = url.searchParams.get("limit");
  if (url.searchParams.getAll("limit").length > 1)
    throw new RequestProblem(400, "INVALID_REQUEST", "limit must not be repeated");
  const limit = limitValue === null ? undefined : Number(limitValue);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100))
    throw new RequestProblem(400, "INVALID_REQUEST", "limit must be an integer from 1 through 100");
  const language = request.headers.get("accept-language") ?? undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (url.searchParams.getAll("cursor").length > 1)
    throw new RequestProblem(400, "INVALID_REQUEST", "cursor must not be repeated");
  return {
    request,
    representation,
    ...(limit === undefined ? {} : { limit }),
    ...(language === undefined ? {} : { language }),
    ...(cursor === undefined ? {} : { cursor })
  };
}

function withLimit(request: OdpCatalogRequest, limit: number | undefined): OdpCatalogRequest {
  return limit === undefined ? request : { ...request, limit };
}

function requireCursor(request: OdpCatalogRequest): void {
  if (request.cursor === undefined)
    throw new RequestProblem(400, "INVALID_REQUEST", "Search continuation requires a cursor");
}

async function requestBody(request: Request): Promise<unknown> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== MEDIA_TYPE)
    throw new RequestProblem(415, "UNSUPPORTED_MEDIA_TYPE", `Content-Type must be ${MEDIA_TYPE}`);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAXIMUM_REQUEST_BYTES)
    throw new RequestProblem(413, "REQUEST_TOO_LARGE", "ODP request body exceeds its byte limit");
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (request.body !== null)
    for await (const value of request.body as AsyncIterable<unknown>) {
      if (!(value instanceof Uint8Array))
        throw new RequestProblem(400, "INVALID_REQUEST", "ODP request body is invalid");
      const chunk = value;
      length += chunk.byteLength;
      if (length > MAXIMUM_REQUEST_BYTES) {
        throw new RequestProblem(
          413,
          "REQUEST_TOO_LARGE",
          "ODP request body exceeds its byte limit"
        );
      }
      chunks.push(chunk);
    }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RequestProblem(400, "INVALID_REQUEST", "ODP request body must use UTF-8");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestProblem(400, "INVALID_REQUEST", "ODP request body must contain valid JSON");
  }
}

function validateOfferingPage(
  page: OfferingPage<Offering | TerseOffering>,
  request: OdpCatalogRequest
): OfferingPage<Offering | TerseOffering> {
  return {
    ...page,
    odp_version: "1.0",
    items: page.items.map((item) => validateOffering(item, request.representation))
  };
}

function validateCollectionPage(
  page: PageEnvelope<Collection | TerseCollection>,
  representation: Representation
): PageEnvelope<Collection | TerseCollection> {
  return {
    ...page,
    odp_version: "1.0",
    items: page.items.map((item) => validateCollection(item, representation))
  };
}

function validateOffering(value: Offering | TerseOffering, representation: Representation) {
  const parsed = parseOffering({ odp_version: "1.0", ...value });
  if (representation === "terse" && parsed.actions !== undefined)
    throw new TypeError("ODP Terse Offering cannot contain Actions");
  if (representation === "full" && "detail_fields" in parsed)
    throw new TypeError("ODP Full Offering cannot contain detail_fields");
  return representation === "full" ? parsed : structuredClone(value);
}

function validateCollection(value: Collection | TerseCollection, representation: Representation) {
  const parsed = parseCollection({ odp_version: "1.0", ...value });
  if (representation === "full" && "detail_fields" in parsed)
    throw new TypeError("ODP Full Collection cannot contain detail_fields");
  return representation === "full" ? parsed : structuredClone(value);
}

function json(value: unknown, language: string): Response {
  return Response.json(value, {
    headers: {
      "content-language": language,
      "content-type": MEDIA_TYPE,
      vary: "Accept-Language"
    }
  });
}

function problem(
  status: number,
  code: string,
  title: string,
  extraHeaders?: OdpResponseHeaders
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", PROBLEM_TYPE);
  return Response.json(
    {
      type: `https://offeringprotocol.org/problems/${code.toLowerCase().replaceAll("_", "-")}`,
      title,
      status,
      code
    },
    { status, headers }
  );
}

function requireMethod(request: Request, expected: "GET" | "POST"): void {
  if (request.method !== expected)
    throw new RequestProblem(405, "METHOD_NOT_ALLOWED", `ODP operation requires ${expected}`, {
      allow: expected
    });
}

function requireAccept(request: Request): void {
  const accept = request.headers.get("accept");
  if (
    accept !== null &&
    !accept.split(",").some((entry) => {
      const mediaType = entry.split(";", 1)[0]?.trim().toLowerCase();
      return mediaType === "*/*" || mediaType === "application/*" || mediaType === MEDIA_TYPE;
    })
  )
    throw new RequestProblem(406, "NOT_ACCEPTABLE", `Accept must allow ${MEDIA_TYPE}`);
}

function normalizeBase(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function resourceId(path: string, prefix: string): string | undefined {
  if (!path.startsWith(prefix)) return undefined;
  const suffix = path.slice(prefix.length);
  return suffix !== "" && !suffix.includes("/") ? decodeIdentifier(suffix) : undefined;
}

function collectionOfferingId(path: string): string | undefined {
  const match = /^\/collections\/([^/]+)\/offerings$/u.exec(path);
  return match?.[1] === undefined ? undefined : decodeIdentifier(match[1]);
}

function decodeIdentifier(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!isLocalResourceIdentifier(decoded)) throw new Error("invalid identifier");
    return decoded;
  } catch {
    throw new RequestProblem(400, "INVALID_REQUEST", "Resource identifier is malformed");
  }
}

function parseRequest<Value>(parser: (value: unknown) => Value, value: unknown): Value {
  try {
    return parser(value);
  } catch (error) {
    if (error instanceof OdpValidationError)
      throw new RequestProblem(400, "INVALID_REQUEST", error.message);
    throw error;
  }
}

function responseLanguage(value: Record<string, unknown>, fallback: string): string {
  return typeof value["language"] === "string" ? value["language"] : fallback;
}

function requireResourceId(actual: string, expected: string, type: string): void {
  if (actual !== expected)
    throw new TypeError(`${type} identifier does not match its request path`);
}

function requireBaseline(catalog: OdpCatalog): void {
  if (typeof catalog.listOfferings !== "function" || typeof catalog.getOffering !== "function")
    throw new TypeError("ODP catalog requires listOfferings and getOffering handlers");
}

function handlerFor(catalog: OdpCatalog, operation: (typeof OPTIONAL_OPERATIONS)[number]) {
  const names = {
    "list-collections": catalog.listCollections,
    "search-collections": catalog.searchCollections,
    "get-collection": catalog.getCollection,
    "list-collection-offerings": catalog.listCollectionOfferings,
    "search-offerings": catalog.searchOfferings
  };
  return names[operation];
}

function requireHandler<Handler>(handler: Handler | undefined, operation: OdpOperation): Handler {
  if (handler === undefined)
    throw new RequestProblem(404, "NOT_FOUND", `${operation} is not supported`);
  return handler;
}

class RequestProblem extends OdpServiceError {}
