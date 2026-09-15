import { createHash } from "node:crypto";

import {
  parseCollection,
  isLocalResourceIdentifier,
  parseOffering,
  parseOfferingSearchResponse,
  parsePage,
  parseProblemDetails,
  parseServiceDocument,
  safeParseCollectionSearchRequest,
  safeParseOfferingSearchRequest,
  type SafeParseResult,
  type Collection,
  type CollectionSearchRequest,
  type AuthenticationRequirement,
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
  /**
   * The language selected for this response by RFC 4647 Lookup over the Service Document's
   * `localizations` (SVC-58), not the raw `Accept-Language` header. `undefined` when the request
   * expressed no preference this Service can serve, in which case the default applies (SVC-59).
   * `localizations` describes the Service Document only, so a catalog whose resources are
   * localized separately reads `Accept-Language` from `request` and runs its own Lookup.
   */
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
  operationAuthentication?: Partial<Record<OdpOperation, AuthenticationRequirement>>;
  /**
   * Called with anything thrown out of a catalog handler before the request becomes a generic 500.
   * Without it an unexpected failure is indistinguishable from a healthy Service to its operator.
   */
  onError?: (error: unknown, request: Request) => void;
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

/** What one request needs from its route: the method it is served as, and its access policy. */
interface Exchange {
  authentication: AuthenticationRequirement;
  method: string;
  request: Request;
}

const MEDIA_TYPE = "application/odp+json";
const PROBLEM_TYPE = "application/problem+json";
const MAXIMUM_REQUEST_BYTES = 65_536;
/** ERR-21: an individual resource, a list page and a search page each cap at 524,288 bytes. */
const MAXIMUM_RESPONSE_BYTES = 524_288;
/** SVC-83: the decoded Service Document caps at 65,536 bytes and a JSON nesting depth of 8. */
const MAXIMUM_DOCUMENT_BYTES = 65_536;
const MAXIMUM_DOCUMENT_DEPTH = 8;
/** ERR-21: JSON nesting depth for every ODP document except the Service Document. */
const MAXIMUM_DEPTH = 16;
/** PAG-06: `next` is a Resource Reference of at most 2048 ASCII characters. */
const MAXIMUM_NEXT_LENGTH = 2048;
/**
 * ERR-04: a Problem Details title carries at most 128 Unicode code points. With a bounded `code`
 * and the `type` derived from it, that bound is also what keeps the whole document inside the
 * 16,384-byte Problem Details limit (ERR-21).
 */
const MAXIMUM_TITLE_LENGTH = 128;
/** ERR-06: a problem code is 1-64 uppercase ASCII letters, digits or underscores, letter-first. */
const PROBLEM_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
/** RFC 9110 §12.4.2: a quality value is `0` or `1` with at most three fractional digits. */
const QUALITY = /^\s*q\s*=\s*(0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)\s*$/iu;
const OPTIONAL_OPERATIONS = [
  "list-collections",
  "search-collections",
  "get-collection",
  "list-collection-offerings",
  "search-offerings"
] as const;

export function createOdpService(options: OdpServiceOptions): OdpService {
  requireBaseline(options.catalog);
  const operationNames: OdpOperation[] = ["list-offerings", "get-offering"];
  for (const operation of OPTIONAL_OPERATIONS)
    if (implementsOperation(options.catalog, operation)) operationNames.push(operation);
  operationNames.sort();
  for (const name of Object.keys(options.operationAuthentication ?? {}))
    if (!operationNames.some((operation) => operation === name))
      throw new TypeError(`Authentication configured for unadvertised ODP operation ${name}`);
  const operations = operationNames.map((name) => ({
    authentication: authenticationOf(name),
    name
  }));
  const document = parseServiceDocument({
    ...options.document,
    odp_version: "1.0",
    operations
  });
  // SVC-84: a Service MUST produce a document within every limit. Core validates the shape but
  // counts neither bytes nor depth, so both budgets are enforced here, at construction.
  requireDocumentLimits(document);
  const endpointBase = normalizeBase(document.http.endpoint_base);

  return {
    document: structuredClone(document),
    async fetch(request) {
      const response = await answer(request);
      // RFC 9110: HEAD is GET without content. This is the outermost boundary, so it strips the
      // body of Problem Details responses too, not only of the ones a route returned.
      if (request.method !== "HEAD") return response;
      return new Response(null, { status: response.status, headers: response.headers });
    }
  };

  function authenticationOf(operation: OdpOperation): AuthenticationRequirement {
    return options.operationAuthentication?.[operation] ?? "not-required";
  }

  async function answer(request: Request): Promise<Response> {
    try {
      return await dispatch(request);
    } catch (error) {
      if (error instanceof OdpServiceError)
        return problem(error.status, error.code, error.message, error.headers);
      report(error, request);
      return problem(500, "INTERNAL_ERROR", "The ODP Service could not complete the request");
    }
  }

  /** An observer is the one thing in the failure path that must not become the failure. */
  function report(error: unknown, request: Request): void {
    try {
      options.onError?.(error, request);
    } catch {
      // The Service still has to answer.
    }
  }

  async function dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    requireAccept(request);
    // Every ODP operation is safe, so HEAD is served by the GET branch throughout.
    const method = request.method === "HEAD" ? "GET" : request.method;
    const exchange = (operation: OdpOperation): Exchange => ({
      authentication: authenticationOf(operation),
      method,
      request
    });
    if (url.pathname === "/.well-known/odp") {
      requireMethod(method, ["GET"]);
      // SVC-02: the well-known document is retrievable without enrollment or authentication.
      const open: Exchange = { authentication: "not-required", method, request };
      return respond(document, document.language, open, MAXIMUM_RESPONSE_BYTES);
    }
    if (!url.pathname.startsWith(`${endpointBase}/`))
      throw new RequestProblem(404, "NOT_FOUND", "ODP resource not found");
    const path = url.pathname.slice(endpointBase.length);
    if (path === "/offerings") {
      requireMethod(method, ["GET"]);
      const input = catalogRequest(request, url, method, "terse");
      const page = validateOfferingPage(await options.catalog.listOfferings(input), input, url);
      return respondPage(page, input, exchange("list-offerings"));
    }
    if (path === "/offerings/search") {
      const handler = requireHandler(options.catalog.searchOfferings, "search-offerings");
      const input = catalogRequest(request, url, method, "terse");
      if (method === "GET") {
        requireCursor(input);
        const page = validateOfferingPage(await handler(undefined, input), input, url);
        return respondPage(page, input, exchange("search-offerings"));
      }
      requireMethod(method, ["GET", "POST"]);
      const query = parseRequest(
        safeParseOfferingSearchRequest,
        "Offering search request",
        await requestBody(request)
      );
      const searchInput = withLimit(input, query.limit);
      const page = validateOfferingPage(
        await handler(query, searchInput),
        searchInput,
        url,
        query.refinements
      );
      return respondPage(page, searchInput, exchange("search-offerings"));
    }
    const offeringId = resourceId(path, "/offerings/");
    if (offeringId !== undefined) {
      requireMethod(method, ["GET"]);
      const input = catalogRequest(request, url, method, "full");
      const offering = await options.catalog.getOffering(offeringId, input);
      if (offering === undefined) throw new RequestProblem(404, "NOT_FOUND", "Offering not found");
      const validated = validateOffering(offering, input.representation);
      requireResourceId(validated.id, offeringId, "Offering");
      return respondResource(validated, input, exchange("get-offering"));
    }
    if (path === "/collections") {
      requireMethod(method, ["GET"]);
      const input = catalogRequest(request, url, method, "terse");
      const handler = requireHandler(options.catalog.listCollections, "list-collections");
      const page = validateCollectionPage(await handler(input), input, url);
      return respondPage(page, input, exchange("list-collections"));
    }
    if (path === "/collections/search") {
      const handler = requireHandler(options.catalog.searchCollections, "search-collections");
      const input = catalogRequest(request, url, method, "terse");
      if (method === "GET") {
        requireCursor(input);
        const page = validateCollectionPage(await handler(undefined, input), input, url);
        return respondPage(page, input, exchange("search-collections"));
      }
      requireMethod(method, ["GET", "POST"]);
      const query = parseRequest(
        safeParseCollectionSearchRequest,
        "Collection search request",
        await requestBody(request)
      );
      const searchInput = withLimit(input, query.limit);
      const page = validateCollectionPage(await handler(query, searchInput), searchInput, url);
      return respondPage(page, searchInput, exchange("search-collections"));
    }
    const collectionOfferings = collectionOfferingId(path);
    if (collectionOfferings !== undefined) {
      requireMethod(method, ["GET"]);
      const input = catalogRequest(request, url, method, "terse");
      const handler = requireHandler(
        options.catalog.listCollectionOfferings,
        "list-collection-offerings"
      );
      const page = validateOfferingPage(await handler(collectionOfferings, input), input, url);
      return respondPage(page, input, exchange("list-collection-offerings"));
    }
    const collectionId = resourceId(path, "/collections/");
    if (collectionId !== undefined) {
      requireMethod(method, ["GET"]);
      const input = catalogRequest(request, url, method, "full");
      const handler = requireHandler(options.catalog.getCollection, "get-collection");
      const collection = await handler(collectionId, input);
      if (collection === undefined)
        throw new RequestProblem(404, "NOT_FOUND", "Collection not found");
      const validated = validateCollection(collection, input.representation);
      requireResourceId(validated.id, collectionId, "Collection");
      return respondResource(validated, input, exchange("get-collection"));
    }
    throw new RequestProblem(404, "NOT_FOUND", "ODP resource not found");
  }

  function respondPage(
    page: PageEnvelope<unknown>,
    input: OdpCatalogRequest,
    exchange: Exchange
  ): Response {
    return respond(
      page,
      responseLanguage(page, input, document.language),
      exchange,
      MAXIMUM_RESPONSE_BYTES
    );
  }

  function respondResource(
    value: Record<string, unknown>,
    input: OdpCatalogRequest,
    exchange: Exchange
  ): Response {
    // A single resource is a Top-Level Document, so it carries the version its page items must not.
    return respond(
      { odp_version: "1.0", ...value },
      responseLanguage(value, input, document.language),
      exchange,
      MAXIMUM_RESPONSE_BYTES
    );
  }

  function catalogRequest(
    request: Request,
    url: URL,
    method: string,
    defaultRepresentation: Representation
  ): OdpCatalogRequest {
    if (url.searchParams.getAll("representation").length > 1)
      throw new RequestProblem(400, "INVALID_REQUEST", "representation must not be repeated");
    const representation = url.searchParams.get("representation") ?? defaultRepresentation;
    if (representation !== "terse" && representation !== "full")
      throw new RequestProblem(400, "INVALID_REQUEST", "representation must be terse or full");
    if (url.searchParams.getAll("cursor").length > 1)
      throw new RequestProblem(400, "INVALID_REQUEST", "cursor must not be repeated");
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const limit = queryLimit(url, method);
    const language = selectLanguage(
      request.headers.get("accept-language"),
      document.language,
      document.localizations
    );
    return {
      request,
      representation,
      ...(limit === undefined ? {} : { limit }),
      ...(language === undefined ? {} : { language }),
      ...(cursor === undefined ? {} : { cursor })
    };
  }
}

/** PAG-13: a `POST` search carries `limit` in its request body; a `GET` carries it in the query. */
function queryLimit(url: URL, method: string): number | undefined {
  if (method === "POST") {
    if (url.searchParams.has("limit"))
      throw new RequestProblem(
        400,
        "INVALID_REQUEST",
        "A POST search carries limit as a request-body member"
      );
    return undefined;
  }
  if (url.searchParams.getAll("limit").length > 1)
    throw new RequestProblem(400, "INVALID_REQUEST", "limit must not be repeated");
  return parseLimit(url.searchParams.get("limit"));
}

/**
 * Serializes once so the response can be measured, given a validator, and conditionally answered
 * with `304` — none of which is possible when the body is built inside `Response.json`.
 */
function respond(value: object, language: string, exchange: Exchange, maximum: number): Response {
  const body = JSON.stringify(value);
  const bytes = Buffer.byteLength(body, "utf8");
  // ERR-19: a conformant Agent stops reading an over-limit document (ERR-20), so emitting one
  // produces a response the caller cannot use. It fails here instead.
  if (bytes > maximum)
    throw new TypeError(
      `ODP response of ${String(bytes)} bytes exceeds its limit of ${String(maximum)}`
    );
  if (depth(value) > MAXIMUM_DEPTH)
    throw new TypeError("ODP response exceeds its nesting-depth limit");
  const etag = entityTag(language, body);
  const authenticated = exchange.authentication !== "not-required";
  const headers = new Headers({
    "content-language": language,
    "content-type": MEDIA_TYPE,
    etag,
    vary: authenticated ? "Accept, Accept-Language, Authorization" : "Accept, Accept-Language"
  });
  // A representation an operation can authenticate MUST NOT be reused for a different
  // authentication context, which a shared cache can only honour when the response says so.
  if (authenticated) headers.set("cache-control", "private");
  // PAG-31: honour conditional retrieval so an Agent's revalidation is not a full transfer.
  if (!matchesEntityTag(exchange.request.headers.get("if-none-match"), etag))
    return new Response(body, { headers });
  // RFC 9110 §13.1.2: a matched `If-None-Match` is `304` for GET and HEAD, `412` for anything else.
  if (exchange.method === "GET") return new Response(null, { status: 304, headers });
  throw new RequestProblem(
    412,
    "PRECONDITION_FAILED",
    "If-None-Match matched the current representation"
  );
}

/**
 * A strong validator over the negotiated language and the exact bytes served. Hashing the body
 * alone would give two language variants of an unlocalized body one validator (SVC-61).
 */
function entityTag(language: string, body: string): string {
  const digest = createHash("sha256")
    .update(language)
    .update("\u0000")
    .update(body)
    .digest("base64url");
  return `"${digest.slice(0, 27)}"`;
}

function matchesEntityTag(header: string | null, etag: string): boolean {
  if (header === null) return false;
  // RFC 9110 compares If-None-Match validators weakly, so `W/"x"` matches the strong `"x"`
  // this Service issues.
  return header
    .split(",")
    .map((candidate) => candidate.trim())
    .map((candidate) => (candidate.startsWith("W/") ? candidate.slice(2) : candidate))
    .some((candidate) => candidate === "*" || candidate === etag);
}

/**
 * RFC 4647 Lookup over the localizations the Service advertises (SVC-58). Returns `undefined` when
 * no range matches, which leaves the caller on the default representation rather than answering
 * `406` (SVC-59).
 */
export function selectLanguage(
  header: string | null,
  fallback: string,
  localizations: readonly string[]
): string | undefined {
  if (header === null) return undefined;
  const entries: { quality: number; range: string }[] = [];
  for (const entry of header.split(",")) {
    const range = rangeOf(entry);
    const quality = qualityOf(entry);
    if (range !== "" && quality !== undefined) entries.push({ quality, range });
  }
  // RFC 9110 §12.4.2: `q=0` marks a range unacceptable. It carves tags out of the `*` residual
  // below rather than competing for a match of its own.
  const refused = entries
    .filter(({ quality, range }) => quality === 0 && range !== "*")
    .map(({ range }) => range);
  const wanted = entries
    .filter(({ quality, range }) => quality > 0 && range !== "*")
    .sort((left, right) => right.quality - left.quality);
  for (const { range } of wanted) {
    const found = lookup(range, localizations);
    if (found !== undefined) return found;
  }
  // RFC 9110 §12.5.4: `*` matches every tag no other range in the field matched, so it is the
  // residual and can never outrank a range the caller named.
  if (!entries.some(({ quality, range }) => range === "*" && quality > 0)) return undefined;
  return [fallback, ...localizations].find(
    (tag) => !refused.some((range) => covers(range, tag.toLowerCase()))
  );
}

/** RFC 4647 Lookup: truncate the range at its subtag boundaries until a tag matches it exactly. */
function lookup(range: string, localizations: readonly string[]): string | undefined {
  const available = localizations.map((tag) => ({ lowered: tag.toLowerCase(), tag }));
  let candidate = range;
  for (;;) {
    const found = available.find(({ lowered }) => lowered === candidate);
    if (found !== undefined) return found.tag;
    const cut = candidate.lastIndexOf("-");
    if (cut < 0) return undefined;
    candidate = candidate.slice(0, cut);
    // A single-character subtag is an extension or private-use singleton; drop it with its parent.
    const singleton = candidate.lastIndexOf("-");
    if (singleton >= 0 && candidate.length - singleton === 2)
      candidate = candidate.slice(0, singleton);
  }
}

/** RFC 4647 basic filtering: a range covers the tag it equals and any tag it prefixes. */
function covers(range: string, tag: string): boolean {
  return tag === range || tag.startsWith(`${range}-`);
}

/** The range of one `Accept` or `Accept-Language` entry, lowercased and without its parameters. */
function rangeOf(entry: string): string {
  const semicolon = entry.indexOf(";");
  return (semicolon < 0 ? entry : entry.slice(0, semicolon)).trim().toLowerCase();
}

/**
 * The entry's quality weight. An entry with no `q` parameter carries the default weight of 1; one
 * whose `q` is outside the RFC 9110 grammar has no weight at all and is discarded by the caller,
 * so a malformed parameter cannot promote an entry above a well-formed one.
 */
function qualityOf(entry: string): number | undefined {
  const semicolon = entry.indexOf(";");
  if (semicolon < 0) return 1;
  const parameters = entry.slice(semicolon + 1).split(";");
  const quality = parameters.find((parameter) => /^\s*q\s*=/iu.test(parameter));
  if (quality === undefined) return 1;
  const value = QUALITY.exec(quality);
  return value?.[1] === undefined ? undefined : Number(value[1]);
}

/** PAG-13: `limit` is an integer from 1 through 100, not merely something `Number()` accepts. */
function parseLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^[0-9]{1,3}$/u.test(value))
    throw new RequestProblem(400, "INVALID_REQUEST", "limit must be an integer from 1 through 100");
  const limit = Number(value);
  if (limit < 1 || limit > 100)
    throw new RequestProblem(400, "INVALID_REQUEST", "limit must be an integer from 1 through 100");
  return limit;
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
  const bytes = await readBounded(request.body);
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

/**
 * The byte view of a request body. `Request["body"]` is declared with an `any` element type, which
 * makes every chunk an unchecked value.
 */
interface ByteStream {
  getReader(): {
    read(): Promise<{ done: true } | { done: false; value: Uint8Array }>;
    releaseLock(): void;
  };
}

/** Reads the body without ever holding more than the protocol's request limit in memory. */
async function readBounded(stream: ByteStream | null): Promise<Uint8Array> {
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = part.value;
      length += chunk.byteLength;
      if (length > MAXIMUM_REQUEST_BYTES)
        throw new RequestProblem(
          413,
          "REQUEST_TOO_LARGE",
          "ODP request body exceeds its byte limit"
        );
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function validateOfferingPage(
  page: OfferingPage<Offering | TerseOffering>,
  request: OdpCatalogRequest,
  url: URL,
  requestedRefinements?: string[]
): OfferingPage<Offering | TerseOffering> {
  const items = requirePageItems(page).map((item) =>
    validateOffering(item, request.representation)
  );
  const envelope = { ...page, odp_version: "1.0" as const, items };
  requireEnvelope(envelope, url);
  requireRefinements(envelope, request, requestedRefinements);
  // A catalog supplies `next`, `auth_expands` and `refinements` alongside its items, so the
  // envelope is validated as a whole.
  return parseOfferingSearchResponse(envelope) as OfferingPage<Offering | TerseOffering>;
}

function validateCollectionPage(
  page: PageEnvelope<Collection | TerseCollection>,
  request: OdpCatalogRequest,
  url: URL
): PageEnvelope<Collection | TerseCollection> {
  const items = requirePageItems(page).map((item) =>
    validateCollection(item, request.representation)
  );
  const envelope = { ...page, odp_version: "1.0" as const, items };
  requireEnvelope(envelope, url);
  return parsePage(envelope) as PageEnvelope<Collection | TerseCollection>;
}

function requirePageItems<Item>(page: PageEnvelope<Item>): Item[] {
  if (!Array.isArray(page.items)) throw new TypeError("ODP page must contain an items array");
  if (page.items.length > 100) throw new TypeError("ODP page cannot contain more than 100 items");
  return page.items;
}

/** Checks the envelope members core's page schema does not constrain. */
function requireEnvelope(page: PageEnvelope<unknown>, url: URL): void {
  const next = page.next;
  if (next === undefined) return;
  if (typeof next !== "string" || next === "")
    throw new TypeError("ODP continuation reference must be a non-empty string");
  if (next.length > MAXIMUM_NEXT_LENGTH)
    throw new TypeError("ODP continuation reference exceeds its length limit");
  if (/[^ -~]/u.test(next)) throw new TypeError("ODP continuation reference must be ASCII");
  let resolved: URL;
  try {
    resolved = new URL(next, url);
  } catch {
    throw new TypeError("ODP continuation reference is not a valid reference");
  }
  // PAG-07: `next` MUST resolve to the same origin as the initial operation.
  if (resolved.origin !== url.origin)
    throw new TypeError("ODP continuation reference must remain on the Service origin");
  // PAG-11: a continuation MUST advance traversal, so it cannot point back at this request.
  if (resolved.href === url.href)
    throw new TypeError("ODP continuation reference must advance past this request");
}

function requireRefinements(
  page: OfferingPage<unknown>,
  request: OdpCatalogRequest,
  requested: string[] | undefined
): void {
  if (page.refinements === undefined) return;
  // OFR-15: only the initial response of a search may carry refinements.
  if (request.cursor !== undefined)
    throw new TypeError("ODP Offering search continuation cannot contain refinements");
  // OFR-14: refinements only when the request asked for them.
  if (requested === undefined)
    throw new TypeError("ODP Offering search returned refinements that were not requested");
  const allowed = new Set(requested);
  const returned = new Set<string>();
  for (const group of page.refinements) {
    // FLT-30: every `filter_id` occurs in the request and is unique among the returned groups.
    if (!allowed.has(group.filter_id))
      throw new TypeError(
        `ODP Offering search returned refinement ${group.filter_id} that was not requested`
      );
    if (returned.has(group.filter_id))
      throw new TypeError(
        `ODP Offering search returned refinement ${group.filter_id} more than once`
      );
    returned.add(group.filter_id);
  }
}

function validateOffering(
  value: Offering | TerseOffering,
  representation: Representation
): Record<string, unknown> & { id: string } {
  const parsed = parseOffering({ odp_version: "1.0", ...value });
  if (representation === "terse" && parsed.actions !== undefined)
    throw new TypeError("ODP Terse Offering cannot contain Actions");
  if (representation === "full" && "detail_fields" in parsed)
    throw new TypeError("ODP Full Offering cannot contain detail_fields");
  return withoutVersion(parsed);
}

function validateCollection(
  value: Collection | TerseCollection,
  representation: Representation
): Record<string, unknown> & { id: string } {
  const parsed = parseCollection({ odp_version: "1.0", ...value });
  if (representation === "full" && "detail_fields" in parsed)
    throw new TypeError("ODP Full Collection cannot contain detail_fields");
  return withoutVersion(parsed);
}

/** VER-03: an item nested in a page inherits its container's version and must not restate it. */
function withoutVersion(value: { id: string }): Record<string, unknown> & { id: string } {
  const copy = structuredClone(value) as Record<string, unknown> & { id: string };
  delete copy["odp_version"];
  return copy;
}

function problem(
  status: number,
  code: string,
  title: string,
  extraHeaders?: OdpResponseHeaders
): Response {
  try {
    return problemResponse(status, code, title, extraHeaders);
  } catch {
    // `problem` runs inside the catch that turns a failure into a response, so anything it throws
    // escapes `fetch` and rejects the caller's promise. A handler must always answer.
    return problemResponse(500, "INTERNAL_ERROR", "The ODP Service could not complete the request");
  }
}

function problemResponse(
  status: number,
  code: string,
  title: string,
  extraHeaders?: OdpResponseHeaders
): Response {
  const safeStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
  const safeCode = PROBLEM_CODE.test(code) ? code : "INTERNAL_ERROR";
  const safeTitle = boundedTitle(title, safeStatus);
  const headers = new Headers(safeStatus === status ? extraHeaders : undefined);
  headers.set("content-type", PROBLEM_TYPE);
  // ERR-32: a 429 MUST carry Retry-After, and ERR-33 recommends it on 503. A Service that leaves it
  // off is nonconformant, and the Agent's retry policy has nothing to honour.
  if ((safeStatus === 429 || safeStatus === 503) && !headers.has("retry-after"))
    headers.set("retry-after", "1");
  const body = parseProblemDetails({
    type: `https://offeringprotocol.org/problems/${safeCode.toLowerCase().replaceAll("_", "-")}`,
    title: safeTitle,
    status: safeStatus,
    code: safeCode
  });
  return new Response(JSON.stringify(body), { status: safeStatus, headers });
}

function boundedTitle(title: string, status: number): string {
  const candidate = title.trim() === "" ? `ODP request failed with HTTP ${String(status)}` : title;
  return [...candidate].length > MAXIMUM_TITLE_LENGTH
    ? [...candidate].slice(0, MAXIMUM_TITLE_LENGTH).join("")
    : candidate;
}

function requireMethod(method: string, allowed: readonly ("GET" | "POST")[]): void {
  if (!allowed.some((candidate) => candidate === method))
    throw new RequestProblem(
      405,
      "METHOD_NOT_ALLOWED",
      `ODP operation requires ${allowed.join(" or ")}`,
      // RFC 9110 requires Allow to enumerate every method the resource supports. Every ODP
      // operation answers GET, so HEAD is always among them.
      { allow: [...allowed, "HEAD"].join(", ") }
    );
}

function requireAccept(request: Request): void {
  const accept = request.headers.get("accept");
  if (accept === null) return;
  const acceptable = accept.split(",").some((entry) => {
    const mediaType = rangeOf(entry);
    if (mediaType !== "*/*" && mediaType !== "application/*" && mediaType !== MEDIA_TYPE)
      return false;
    // RFC 9110: `q=0` means the range is explicitly *not* acceptable, and a `q` outside the
    // quality grammar leaves the entry with no weight to honour.
    const quality = qualityOf(entry);
    return quality !== undefined && quality > 0;
  });
  if (!acceptable)
    throw new RequestProblem(406, "NOT_ACCEPTABLE", `Accept must allow ${MEDIA_TYPE}`);
}

function normalizeBase(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function resourceId(path: string, prefix: string): string | undefined {
  if (!path.startsWith(prefix)) return undefined;
  const suffix = path.slice(prefix.length);
  return suffix !== "" && !suffix.includes("/") ? resourceIdentifier(suffix) : undefined;
}

function collectionOfferingId(path: string): string | undefined {
  const match = /^\/collections\/([^/]+)\/offerings$/u.exec(path);
  return match?.[1] === undefined ? undefined : resourceIdentifier(match[1]);
}

/**
 * SVC-66: identifier placeholders are substituted verbatim, with no percent-encoding or decoding.
 * A path segment is therefore compared as received, which also keeps one resource on one URL.
 */
function resourceIdentifier(value: string): string {
  if (!isLocalResourceIdentifier(value))
    throw new RequestProblem(400, "INVALID_REQUEST", "Resource identifier is malformed");
  return value;
}

/**
 * Reports why a request document was rejected. The safe parser is used rather than the throwing
 * one so a validation failure stays a `400` and can never be confused with a Service fault.
 */
function parseRequest<Value>(
  safeParse: (value: unknown) => SafeParseResult<Value>,
  documentType: string,
  value: unknown
): Value {
  const result = safeParse(value);
  if (result.success) return result.data;
  const detail = result.issues.map(({ path, message }) => `${path} ${message}`).join("; ");
  throw new RequestProblem(400, "INVALID_REQUEST", `Invalid ODP ${documentType}: ${detail}`);
}

/**
 * The language actually served: the resource's own tag when it declares one, otherwise the tag
 * Lookup selected for this request, otherwise the Service default (OFR-20, SVC-59).
 */
function responseLanguage(
  value: Record<string, unknown>,
  request: OdpCatalogRequest,
  fallback: string
): string {
  const declared = value["language"];
  if (typeof declared === "string") return declared;
  return request.language ?? fallback;
}

function requireResourceId(actual: string, expected: string, type: string): void {
  if (actual !== expected)
    throw new TypeError(`${type} identifier does not match its request path`);
}

function requireBaseline(catalog: OdpCatalog): void {
  if (typeof catalog.listOfferings !== "function" || typeof catalog.getOffering !== "function")
    throw new TypeError("ODP catalog requires listOfferings and getOffering handlers");
}

function requireDocumentLimits(document: ServiceDocument): void {
  const bytes = Buffer.byteLength(JSON.stringify(document), "utf8");
  if (bytes > MAXIMUM_DOCUMENT_BYTES)
    throw new TypeError(
      `ODP Service Document of ${String(bytes)} bytes exceeds its limit of ${String(MAXIMUM_DOCUMENT_BYTES)}`
    );
  if (depth(document) > MAXIMUM_DOCUMENT_DEPTH)
    throw new TypeError("ODP Service Document exceeds its nesting-depth limit");
}

/** Container nesting measured from the top-level document (ERR-18). */
function depth(value: object): number {
  let maximum = 0;
  const pending: { depth: number; value: object }[] = [{ depth: 1, value }];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
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

/** SVC-82: an optional operation is advertised exactly when the catalog implements its handler. */
function implementsOperation(
  catalog: OdpCatalog,
  operation: (typeof OPTIONAL_OPERATIONS)[number]
): boolean {
  const handlers = {
    "list-collections": catalog.listCollections,
    "search-collections": catalog.searchCollections,
    "get-collection": catalog.getCollection,
    "list-collection-offerings": catalog.listCollectionOfferings,
    "search-offerings": catalog.searchOfferings
  };
  return handlers[operation] !== undefined;
}

function requireHandler<Handler>(handler: Handler | undefined, operation: OdpOperation): Handler {
  if (handler === undefined)
    throw new RequestProblem(404, "NOT_FOUND", `${operation} is not supported`);
  return handler;
}

class RequestProblem extends OdpServiceError {}
