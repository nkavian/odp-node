import type { ErrorObject } from "ajv";
import { parse as parseLanguageTag } from "bcp-47";

import type {
  Collection,
  CollectionSearchRequest,
  FilterDefinition,
  Offering,
  OfferingPage,
  OfferingSearchRequest,
  PageEnvelope,
  ProblemDetails,
  ResourceIdentity,
  ServiceDocument,
  SortDefinition
} from "./models.js";
import { PAYMENT_OPTIONS } from "./models.js";
import { ajv } from "./schema-registry.js";

function isLanguageTag(value: string): boolean {
  const parsed = parseLanguageTag(value, { normalize: false });
  const populated =
    parsed.language !== null ||
    parsed.irregular !== null ||
    parsed.regular !== null ||
    parsed.privateuse.length > 0;
  const variants = parsed.variants.map((variant) => variant.toLowerCase());
  const extensions = parsed.extensions.map(({ singleton }) => singleton.toLowerCase());
  return (
    populated &&
    new Set(variants).size === variants.length &&
    new Set(extensions).size === extensions.length
  );
}

export interface ValidationIssue {
  path: string;
  keyword: string;
  message: string;
  params: Readonly<Record<string, unknown>>;
}

export type SafeParseResult<Value> =
  { success: true; data: Value } | { success: false; issues: ValidationIssue[] };

export class OdpValidationError extends Error {
  readonly issues: ValidationIssue[];
  readonly documentType: string;

  constructor(documentType: string, issues: ValidationIssue[]) {
    super(`Invalid ODP ${documentType}`);
    this.name = "OdpValidationError";
    this.documentType = documentType;
    this.issues = issues;
  }
}

function issuesFrom(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? "Validation failed",
    params: error.params
  }));
}

function serviceDocumentIssues(value: ServiceDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (path: string, keyword: string, message: string): void => {
    issues.push({ path, keyword, message, params: {} });
  };

  if ("id" in value) add("/id", "prohibited", "must not appear in a Service Document");
  if ("web_url" in value) add("/web_url", "prohibited", "must not appear in a Service Document");
  if (!isLanguageTag(value.language)) add("/language", "language-tag", "must be a language tag");

  const folded = value.localizations.map((language) => language.toLowerCase());
  if (value.localizations.some((language) => !isLanguageTag(language))) {
    add("/localizations", "language-tag", "must contain only language tags");
  }
  if (new Set(folded).size !== folded.length) {
    add("/localizations", "unique-language-tag", "must be unique without regard to case");
  }
  if (!folded.includes(value.language.toLowerCase())) {
    add("/localizations", "contains-default-language", "must contain the default language");
  }

  const keywordCodePoints = value.keywords?.reduce(
    (total, keyword) => total + Array.from(keyword).length,
    0
  );
  if (keywordCodePoints !== undefined && keywordCodePoints > 1024) {
    add("/keywords", "max-code-points", "must contain no more than 1024 code points in total");
  }
  if (
    value.search_capabilities !== undefined &&
    !value.operations.some(({ name }) => name === "search-offerings")
  ) {
    add("/search_capabilities", "operation-support", "requires the search-offerings operation");
  }
  return issues;
}

function representationIssues(value: {
  images?: { src: string }[];
  language?: string;
  localizations?: string[];
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const folded = value.localizations?.map((language) => language.toLowerCase());
  if (value.language !== undefined && !isLanguageTag(value.language)) {
    issues.push({
      path: "/language",
      keyword: "language-tag",
      message: "must be a language tag",
      params: {}
    });
  }
  if (value.localizations?.some((language) => !isLanguageTag(language)) === true) {
    issues.push({
      path: "/localizations",
      keyword: "language-tag",
      message: "must contain only language tags",
      params: {}
    });
  }
  if (folded !== undefined && new Set(folded).size !== folded.length) {
    issues.push({
      path: "/localizations",
      keyword: "unique-language-tag",
      message: "must be unique without regard to case",
      params: {}
    });
  }
  if (
    value.language !== undefined &&
    folded !== undefined &&
    !folded.includes(value.language.toLowerCase())
  ) {
    issues.push({
      path: "/localizations",
      keyword: "contains-language",
      message: "must contain the representation language",
      params: {}
    });
  }
  const imageSources = value.images?.map(({ src }) => src);
  if (imageSources !== undefined && new Set(imageSources).size !== imageSources.length) {
    issues.push({
      path: "/images",
      keyword: "unique-image-source",
      message: "must contain unique image sources",
      params: {}
    });
  }
  return issues;
}

function filterDefinitionIssues(value: FilterDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const comparisonOperators = new Set(["gt", "gte", "lt", "lte"]);
  if (
    (value.type === "string" || value.type === "boolean") &&
    value.operators.some((operator) => comparisonOperators.has(operator))
  ) {
    issues.push({
      path: "/operators",
      keyword: "operator-type",
      message: "contains an operator incompatible with the Filter type",
      params: {}
    });
  }
  if (value.type === "boolean" && value.unit !== undefined) {
    issues.push({
      path: "/unit",
      keyword: "unit-type",
      message: "must not appear on a boolean Filter",
      params: {}
    });
  }
  return issues;
}

function validator<Value>(
  schemaId: string,
  documentType: string,
  refine?: (value: Value) => ValidationIssue[]
) {
  const validate = ajv.getSchema<Value>(schemaId);
  if (validate === undefined) {
    throw new Error(`Missing bundled ODP schema: ${schemaId}`);
  }

  const safeParse = (value: unknown): SafeParseResult<Value> => {
    if (validate(value)) {
      const data = value as Value;
      const issues = refine?.(data) ?? [];
      if (issues.length === 0) return { success: true, data };
      return { success: false, issues };
    }
    return { success: false, issues: issuesFrom(validate.errors) };
  };

  const parse = (value: unknown): Value => {
    const result = safeParse(value);
    if (result.success) return result.data;
    throw new OdpValidationError(documentType, result.issues);
  };

  return { parse, safeParse };
}

const serviceDocument = validator<ServiceDocument>(
  "https://offeringprotocol.org/schemas/service-document.schema.json",
  "Service Document",
  serviceDocumentIssues
);

export type AgentResponseKind =
  | "collection"
  | "collection-page"
  | "filter-page"
  | "offering"
  | "offering-page"
  | "problem"
  | "service-document"
  | "sort-page";

/** @internal */
export function normalizeAgentResponse(value: unknown, kind: AgentResponseKind): unknown {
  if (!isRecord(value)) return value;
  if (kind === "service-document") return normalizeServiceDocument(value);
  if (kind === "collection") return normalizeRepresentation(value, false);
  if (kind === "offering") return normalizeRepresentation(value, true);
  if (kind === "problem") return normalizeProblem(value);
  const items: unknown = value["items"];
  if (!Array.isArray(items)) return value;

  const normalized = { ...value };
  if (kind === "filter-page") {
    normalized["items"] = (items as unknown[]).filter(isKnownFilterDefinition);
  } else if (kind === "sort-page") {
    normalized["items"] = (items as unknown[]).filter(isKnownSortDefinition);
  } else {
    const offering = kind === "offering-page";
    normalized["items"] = (items as unknown[]).map((item) =>
      isRecord(item) ? normalizeRepresentation(item, offering) : item
    );
  }
  return normalized;
}

function normalizeServiceDocument(value: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...value };
  if (isRecord(value["protocols"])) {
    const protocols = { ...value["protocols"] };
    filterProtocolCategory(protocols, "enrollment", ["aep"]);
    filterProtocolCategory(protocols, "payments", ["mpp", "x402"]);
    filterProtocolCategory(protocols, "trust", ["tap"]);
    filterUnknownAuthentication(protocols, "payments");
    filterPaymentOptions(protocols);
    if (Object.keys(protocols).length === 0) delete normalized["protocols"];
    else normalized["protocols"] = protocols;
  }
  filterNamedList(normalized, "operations", [
    "get-collection",
    "get-offering",
    "list-collection-offerings",
    "list-collections",
    "list-offerings",
    "search-collections",
    "search-offerings"
  ]);
  filterUnknownAuthentication(normalized, "operations");
  filterTypedList(normalized, "mcp", ["streamable-http"]);
  filterClosedObjectList(normalized, "operations", ["authentication", "name"]);
  filterClosedObjectList(normalized, "mcp", ["description", "name", "type", "url"]);
  if (isRecord(value["branding"])) {
    const branding = Object.fromEntries(
      Object.entries(value["branding"]).filter(([key]) => ["icon", "logo"].includes(key))
    );
    filterTypedMember(branding, "icon", ["image/png", "image/svg+xml", "image/webp"]);
    filterTypedMember(branding, "logo", ["image/png", "image/svg+xml", "image/webp"]);
    stripObjectMember(branding, "icon", ["src", "type"]);
    stripObjectMember(branding, "logo", ["src", "type"]);
    if (Object.keys(branding).length === 0) delete normalized["branding"];
    else normalized["branding"] = branding;
  }
  if (isRecord(value["search_capabilities"])) {
    const capabilities = normalizeSearchCapabilities(value["search_capabilities"]);
    if (Object.keys(capabilities).length === 0) delete normalized["search_capabilities"];
    else normalized["search_capabilities"] = capabilities;
  }
  return normalized;
}

function normalizeRepresentation(
  value: Record<string, unknown>,
  offering: boolean
): Record<string, unknown> {
  const normalized = { ...value };
  filterTypedList(normalized, "images", [
    "image/avif",
    "image/jpeg",
    "image/png",
    "image/svg+xml",
    "image/webp"
  ]);
  stripObjectList(normalized, "images", ["alt", "height", "src", "type", "width"]);
  if (isRecord(value["search_capabilities"])) {
    const capabilities = normalizeSearchCapabilities(value["search_capabilities"]);
    if (Object.keys(capabilities).length === 0) delete normalized["search_capabilities"];
    else normalized["search_capabilities"] = capabilities;
  }
  if (!offering) return normalized;

  if (isRecord(value["schema"]) && Object.keys(value["schema"]).some((key) => key !== "url")) {
    delete normalized["schema"];
  }

  const price = value["price"];
  if (isRecord(price) && typeof price["type"] === "string") {
    const known = ["fixed", "free", "metered", "quote", "range", "starting_at"];
    if (!known.includes(price["type"])) delete normalized["price"];
  }
  const actions = value["actions"];
  if (Array.isArray(actions)) {
    const filtered = actions.filter((action) => {
      if (!isRecord(action)) return true;
      if (hasUnknownAuthentication(action)) return false;
      if (
        Object.keys(action).some(
          (key) => !["authentication", "description", "http", "id", "openapi", "rel"].includes(key)
        )
      )
        return false;
      if (isRecord(action["http"])) {
        if (
          Object.keys(action["http"]).some(
            (key) => !["href", "method", "request", "response_content_types"].includes(key)
          )
        )
          return false;
        const method = action["http"]["method"];
        if (typeof method === "string" && method !== "GET" && method !== "POST") return false;
        const request = action["http"]["request"];
        if (
          isRecord(request) &&
          Object.keys(request).some((key) => !["content_type", "schema"].includes(key))
        )
          return false;
        if (
          isRecord(request) &&
          isRecord(request["schema"]) &&
          Object.keys(request["schema"]).some((key) => key !== "url")
        )
          return false;
      }
      return (
        !isRecord(action["openapi"]) ||
        !Object.keys(action["openapi"]).some((key) => !["operation_id", "url"].includes(key))
      );
    });
    if (filtered.length === 0) delete normalized["actions"];
    else normalized["actions"] = filtered;
  }
  return normalized;
}

function filterUnknownAuthentication(value: Record<string, unknown>, member: string): void {
  const descriptors = value[member];
  if (!Array.isArray(descriptors)) return;
  const filtered = descriptors.filter(
    (descriptor) => !isRecord(descriptor) || !hasUnknownAuthentication(descriptor)
  );
  if (filtered.length === 0) delete value[member];
  else value[member] = filtered;
}

function hasUnknownAuthentication(value: Record<string, unknown>): boolean {
  const authentication = value["authentication"];
  return (
    typeof authentication === "string" &&
    !["not-required", "optional", "required"].includes(authentication)
  );
}

function normalizeSearchCapabilities(value: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...value };
  filterCapabilityDefinitions(normalized, "filters", isKnownFilterDefinition);
  filterCapabilityDefinitions(normalized, "sorts", isKnownSortDefinition);
  return normalized;
}

function filterCapabilityDefinitions(
  capabilities: Record<string, unknown>,
  name: string,
  recognized: (value: unknown) => boolean
): void {
  const source = capabilities[name];
  if (!isRecord(source) || !Array.isArray(source["inline"])) return;
  const filtered = source["inline"].filter(recognized);
  if (filtered.length === 0) delete capabilities[name];
  else capabilities[name] = { ...source, inline: filtered };
}

function isKnownFilterDefinition(value: unknown): boolean {
  if (!isRecord(value)) return true;
  const types = ["boolean", "date", "date-time", "decimal", "integer", "number", "string"];
  if (typeof value["type"] === "string" && !types.includes(value["type"])) return false;
  const operators = value["operators"];
  if (
    Array.isArray(operators) &&
    operators.some(
      (operator) =>
        typeof operator === "string" &&
        !["eq", "exists", "gt", "gte", "in", "lt", "lte"].includes(operator)
    )
  )
    return false;
  const unit = value["unit"];
  return (
    !isRecord(unit) ||
    typeof unit["system"] !== "string" ||
    ["service", "ucum"].includes(unit["system"])
  );
}

function isKnownSortDefinition(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value["keys"])) return true;
  return !value["keys"].some((key) => {
    if (!isRecord(key)) return false;
    const direction = key["direction"];
    const missing = key["missing"];
    return (
      (typeof direction === "string" && !["ascending", "descending"].includes(direction)) ||
      (typeof missing === "string" && !["first", "last"].includes(missing))
    );
  });
}

function normalizeProblem(value: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(value["invalid_params"])) return value;
  return {
    ...value,
    invalid_params: value["invalid_params"].filter((parameter) => {
      if (!isRecord(parameter) || typeof parameter["in"] !== "string") return true;
      return ["body", "header", "path", "query"].includes(parameter["in"]);
    })
  };
}

function filterNamedList(
  value: Record<string, unknown>,
  member: string,
  recognized: readonly string[]
): void {
  const descriptors = value[member];
  if (!Array.isArray(descriptors)) return;
  const filtered = descriptors.filter(
    (descriptor) =>
      !isRecord(descriptor) ||
      typeof descriptor["name"] !== "string" ||
      recognized.includes(descriptor["name"])
  );
  if (filtered.length === 0) delete value[member];
  else value[member] = filtered;
}

function filterTypedList(
  value: Record<string, unknown>,
  member: string,
  recognized: readonly string[]
): void {
  const descriptors = value[member];
  if (!Array.isArray(descriptors)) return;
  const filtered = descriptors.filter(
    (descriptor) =>
      !isRecord(descriptor) ||
      typeof descriptor["type"] !== "string" ||
      recognized.includes(descriptor["type"])
  );
  if (filtered.length === 0) delete value[member];
  else value[member] = filtered;
}

function filterTypedMember(
  value: Record<string, unknown>,
  member: string,
  recognized: readonly string[]
): void {
  const descriptor = value[member];
  if (
    isRecord(descriptor) &&
    typeof descriptor["type"] === "string" &&
    !recognized.includes(descriptor["type"])
  )
    delete value[member];
}

function filterClosedObjectList(
  value: Record<string, unknown>,
  member: string,
  allowed: readonly string[]
): void {
  const items = value[member];
  if (!Array.isArray(items)) return;
  const filtered = items.filter(
    (item) => !isRecord(item) || !Object.keys(item).some((key) => !allowed.includes(key))
  );
  if (filtered.length === 0) delete value[member];
  else value[member] = filtered;
}

function stripObjectList(
  value: Record<string, unknown>,
  member: string,
  allowed: readonly string[]
): void {
  const items: unknown = value[member];
  if (!Array.isArray(items)) return;
  value[member] = (items as unknown[]).map((item) =>
    isRecord(item)
      ? Object.fromEntries(Object.entries(item).filter(([key]) => allowed.includes(key)))
      : item
  );
}

function stripObjectMember(
  value: Record<string, unknown>,
  member: string,
  allowed: readonly string[]
): void {
  const item = value[member];
  if (!isRecord(item)) return;
  value[member] = Object.fromEntries(Object.entries(item).filter(([key]) => allowed.includes(key)));
}

function filterPaymentOptions(protocols: Record<string, unknown>): void {
  const payments: unknown = protocols["payments"];
  if (!Array.isArray(payments)) return;
  const recognized = new Set<string>(PAYMENT_OPTIONS);
  protocols["payments"] = (payments as unknown[]).map((payment) => {
    if (!isRecord(payment) || !Array.isArray(payment["options"])) return payment;
    const options = payment["options"].filter(
      (option) => typeof option !== "string" || recognized.has(option)
    );
    const normalized = { ...payment };
    if (options.length === 0) delete normalized["options"];
    else normalized["options"] = options;
    return normalized;
  });
}

function agentServiceDocumentValue(value: unknown): unknown {
  return normalizeAgentResponse(value, "service-document");
}

function filterProtocolCategory(
  protocols: Record<string, unknown>,
  category: string,
  recognizedNames: readonly string[]
): void {
  const descriptors = protocols[category];
  if (!Array.isArray(descriptors)) return;

  const filtered = descriptors.filter(
    (descriptor) =>
      !isRecord(descriptor) ||
      typeof descriptor["name"] !== "string" ||
      recognizedNames.includes(descriptor["name"])
  );
  if (filtered.length === descriptors.length) return;
  if (filtered.length === 0) delete protocols[category];
  else protocols[category] = filtered;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAgentServiceDocument(value: unknown): ServiceDocument {
  return serviceDocument.parse(agentServiceDocumentValue(value));
}

export function safeParseAgentServiceDocument(value: unknown): SafeParseResult<ServiceDocument> {
  return serviceDocument.safeParse(agentServiceDocumentValue(value));
}
const collection = validator<Collection>(
  "https://offeringprotocol.org/schemas/collection.schema.json",
  "Collection",
  representationIssues
);
const offering = validator<Offering>(
  "https://offeringprotocol.org/schemas/offering.schema.json",
  "Offering",
  representationIssues
);
const problemDetails = validator<ProblemDetails>(
  "https://offeringprotocol.org/schemas/problem-details.schema.json",
  "Problem Details"
);
const resourceIdentity = validator<ResourceIdentity>(
  "https://offeringprotocol.org/schemas/resource-identity.schema.json",
  "resource identity"
);
const page = validator<PageEnvelope>(
  "https://offeringprotocol.org/schemas/page-envelope.schema.json",
  "page envelope"
);
const collectionSearchRequest = validator<CollectionSearchRequest>(
  "https://offeringprotocol.org/schemas/collection-search-request.schema.json",
  "Collection search request"
);
const offeringSearchRequest = validator<OfferingSearchRequest>(
  "https://offeringprotocol.org/schemas/offering-search-request.schema.json",
  "Offering search request"
);
const offeringSearchResponse = validator<OfferingPage>(
  "https://offeringprotocol.org/schemas/offering-search-response.schema.json",
  "Offering search response"
);
const filterDefinition = validator<FilterDefinition>(
  "https://offeringprotocol.org/schemas/filter-definition.schema.json",
  "Filter Definition",
  filterDefinitionIssues
);
const sortDefinition = validator<SortDefinition>(
  "https://offeringprotocol.org/schemas/sort-definition.schema.json",
  "Sort Definition"
);
const filterDefinitionPage = validator<PageEnvelope<FilterDefinition>>(
  "https://offeringprotocol.org/schemas/filter-definition-page.schema.json",
  "Filter Definition page"
);
const sortDefinitionPage = validator<PageEnvelope<SortDefinition>>(
  "https://offeringprotocol.org/schemas/sort-definition-page.schema.json",
  "Sort Definition page"
);

export const parseServiceDocument = serviceDocument.parse;
export const safeParseServiceDocument = serviceDocument.safeParse;
export const parseCollection = collection.parse;
export const safeParseCollection = collection.safeParse;
export const parseOffering = offering.parse;
export const safeParseOffering = offering.safeParse;
export const parseProblemDetails = problemDetails.parse;
export const safeParseProblemDetails = problemDetails.safeParse;
export const parseResourceIdentity = resourceIdentity.parse;
export const safeParseResourceIdentity = resourceIdentity.safeParse;
export const parsePage = page.parse;
export const safeParsePage = page.safeParse;
export const parseCollectionSearchRequest = collectionSearchRequest.parse;
export const safeParseCollectionSearchRequest = collectionSearchRequest.safeParse;
export const parseOfferingSearchRequest = offeringSearchRequest.parse;
export const safeParseOfferingSearchRequest = offeringSearchRequest.safeParse;
export const parseOfferingSearchResponse = offeringSearchResponse.parse;
export const safeParseOfferingSearchResponse = offeringSearchResponse.safeParse;
export const parseFilterDefinition = filterDefinition.parse;
export const safeParseFilterDefinition = filterDefinition.safeParse;
export const parseSortDefinition = sortDefinition.parse;
export const safeParseSortDefinition = sortDefinition.safeParse;
export const parseFilterDefinitionPage = filterDefinitionPage.parse;
export const safeParseFilterDefinitionPage = filterDefinitionPage.safeParse;
export const parseSortDefinitionPage = sortDefinitionPage.parse;
export const safeParseSortDefinitionPage = sortDefinitionPage.safeParse;

export function parseProblemResponse(value: unknown, httpStatus: number): ProblemDetails {
  const problem = parseProblemDetails(value);
  if (problem.status !== httpStatus) {
    throw new OdpValidationError("Problem Details", [
      {
        path: "/status",
        keyword: "http-status",
        message: "must match the HTTP response status",
        params: { httpStatus }
      }
    ]);
  }
  return problem;
}
