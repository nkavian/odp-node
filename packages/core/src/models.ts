export type OdpVersion = "1.0";
export type Representation = "terse" | "full";
export type ResourceType = "collection" | "offering";
export type OdpOperation =
  | "list-collections"
  | "search-collections"
  | "get-collection"
  | "list-collection-offerings"
  | "list-offerings"
  | "search-offerings"
  | "get-offering";

export type AuthenticationRequirement = "not-required" | "optional" | "required";

export interface OperationDescriptor {
  authentication: AuthenticationRequirement;
  name: OdpOperation;
}

export interface EnrollmentProtocol {
  name: "aep";
}

export const PAYMENT_OPTIONS = Object.freeze([
  "algorand",
  "aptos",
  "arbitrum",
  "avalanche",
  "base",
  "card",
  "ethereum",
  "hedera",
  "inflow",
  "lightning",
  "polygon",
  "solana",
  "stellar",
  "stripe",
  "tempo",
  "ton"
] as const);

export type PaymentOption = (typeof PAYMENT_OPTIONS)[number];

export interface PaymentProtocol {
  authentication: Exclude<AuthenticationRequirement, "optional">;
  name: "mpp" | "x402";
  options?: PaymentOption[];
}

export interface ServiceProtocols {
  enrollment?: [EnrollmentProtocol];
  payments?: [PaymentProtocol] | [PaymentProtocol, PaymentProtocol];
}

export type FilterType =
  "string" | "boolean" | "integer" | "number" | "decimal" | "date" | "date-time";
export type FilterOperator = "eq" | "in" | "lt" | "lte" | "gt" | "gte" | "exists";
export type FilterUnit =
  { system: "ucum"; code: string } | { system: "service"; code: string; title: string };
export interface FilterDefinition extends Record<string, unknown> {
  id: string;
  title: string;
  description: string;
  type: FilterType;
  operators: FilterOperator[];
  unit?: FilterUnit;
  refinable?: true;
}
export interface SortKey extends Record<string, unknown> {
  filter_id: string;
  direction: "ascending" | "descending";
  missing: "first" | "last";
}
export interface SortDefinition extends Record<string, unknown> {
  id: string;
  title: string;
  description: string;
  keys: SortKey[];
}
export type CapabilitySource<Value> =
  { inline: Value[]; linked?: never } | { linked: { href: string }; inline?: never };
export interface SearchCapabilities extends Record<string, unknown> {
  filters?: CapabilitySource<FilterDefinition>;
  sorts?: CapabilitySource<SortDefinition>;
}

export type ServiceBrandingImageType = "image/png" | "image/svg+xml" | "image/webp";

export interface ServiceBrandingImage {
  src: string;
  type?: ServiceBrandingImageType;
}

export interface ServiceBranding {
  icon: ServiceBrandingImage;
  logo: ServiceBrandingImage;
}

export interface ServiceOpenApi {
  url: string;
}

export interface McpEndpoint {
  description?: string;
  name?: string;
  type: "streamable-http";
  url: string;
}

export interface ServiceHttp {
  endpoint_base: string;
  openapi?: ServiceOpenApi;
}

export interface ServiceDocument extends Record<string, unknown> {
  odp_version: OdpVersion;
  name: string;
  description: string;
  documentation_url?: string;
  keywords?: string[];
  language: string;
  localizations: string[];
  mcp?: McpEndpoint[];
  operations: OperationDescriptor[];
  branding?: ServiceBranding;
  http: ServiceHttp;
  payment_origins?: string[];
  protocols?: ServiceProtocols;
  search_capabilities?: SearchCapabilities;
  status_url?: string;
  support_url?: string;
  website_url?: string;
}

export type ResourceImageType =
  "image/avif" | "image/jpeg" | "image/png" | "image/svg+xml" | "image/webp";

export interface ResourceImage {
  alt?: string;
  height?: number;
  src: string;
  type?: ResourceImageType;
  width?: number;
}

export interface Collection extends Record<string, unknown> {
  auth_expands?: true;
  odp_version: OdpVersion;
  id: string;
  name: string;
  description?: string;
  images?: ResourceImage[];
  language?: string;
  localizations?: string[];
  parent_ids?: string[];
  web_url?: string;
  search_capabilities?: SearchCapabilities;
}

export interface TerseCollection extends Record<string, unknown> {
  auth_expands?: true;
  id: string;
  name: string;
  odp_version?: OdpVersion;
  description?: string;
  images?: ResourceImage[];
  language?: string;
  localizations?: string[];
  parent_ids?: string[];
  web_url?: string;
  search_capabilities?: SearchCapabilities;
  detail_fields?: string[];
}

export type PricePreview =
  | { type: "free" }
  | { type: "fixed" | "starting_at"; amount: string; currency: string }
  | { type: "range"; minimum: string; maximum: string; currency: string }
  | { type: "metered"; amount: string; currency: string; unit: string }
  | { type: "quote" }
  | ({ type: string } & Record<string, unknown>);

export interface SchemaReference {
  url: string;
}

export interface ActionRequest {
  content_type?: string;
  schema?: SchemaReference;
}

export interface HttpActionTarget {
  href: string;
  method: "GET" | "POST";
  request?: ActionRequest;
  response_content_types?: string[];
}

export interface OpenApiActionTarget {
  url?: string;
  operation_id: string;
}

export type OfferingAction = {
  authentication: AuthenticationRequirement;
  id: string;
  rel: string;
  description?: string;
} & ({ http: HttpActionTarget; openapi?: never } | { openapi: OpenApiActionTarget; http?: never });

export interface Offering extends Record<string, unknown> {
  auth_expands?: true;
  odp_version: OdpVersion;
  id: string;
  name: string;
  description?: string;
  images?: ResourceImage[];
  language?: string;
  localizations?: string[];
  web_url?: string;
  collection_ids?: string[];
  price?: PricePreview;
  schema?: SchemaReference;
  attributes?: Record<string, unknown>;
  actions?: OfferingAction[];
}

export interface TerseOffering extends Record<string, unknown> {
  auth_expands?: true;
  id: string;
  name: string;
  odp_version?: OdpVersion;
  description?: string;
  images?: ResourceImage[];
  language?: string;
  localizations?: string[];
  web_url?: string;
  collection_ids?: string[];
  price?: PricePreview;
  schema?: SchemaReference;
  attributes?: Record<string, unknown>;
  detail_fields?: string[];
  actions?: never;
}

export interface PageEnvelope<Item = unknown> extends Record<string, unknown> {
  auth_expands?: true;
  odp_version: OdpVersion;
  items: Item[];
  next?: string;
}

export interface InvalidParameter extends Record<string, unknown> {
  in: "body" | "header" | "path" | "query";
  name: string;
  reason: string;
}

export interface ProblemDetails extends Record<string, unknown> {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  instance?: string;
  invalid_params?: InvalidParameter[];
}

export interface ResourceIdentity {
  service: string;
  type: ResourceType;
  id: string;
}

export interface CollectionSearchRequest extends Record<string, unknown> {
  odp_version: OdpVersion;
  query?: string;
  parent_id?: string | null;
  limit?: number;
}

export interface OfferingSearchRequest extends Record<string, unknown> {
  odp_version: OdpVersion;
  query?: string;
  filters?: unknown[];
  collection_id?: string;
  include_descendants?: boolean;
  sort?: string;
  refinements?: string[];
  limit?: number;
}

export interface RefinementBucket extends Record<string, unknown> {
  value: string | boolean | number;
  count: number;
  count_relation?: "lower_bound";
}

export interface RefinementGroup extends Record<string, unknown> {
  filter_id: string;
  values: RefinementBucket[];
}

export interface OfferingPage<Item = unknown> extends PageEnvelope<Item> {
  refinements?: RefinementGroup[];
}
