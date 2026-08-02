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

export interface ServiceProtocols {
  onboarding?: ["aep"];
  payments?: ["mpp"] | ["x402"] | ["mpp", "x402"] | ["x402", "mpp"];
}

export interface SearchCapabilities extends Record<string, unknown> {
  filters?: unknown;
  sorts?: unknown;
}

export interface ServiceDocument extends Record<string, unknown> {
  odp_version: OdpVersion;
  name: string;
  description: string;
  language: string;
  localizations: string[];
  keywords?: string[];
  operations: { supported: OdpOperation[] };
  http: { endpoint_base: string };
  protocols?: ServiceProtocols;
  search_capabilities?: SearchCapabilities;
}

export interface Collection extends Record<string, unknown> {
  odp_version: OdpVersion;
  id: string;
  name: string;
  description?: string;
  language?: string;
  localizations?: string[];
  parent_ids?: string[];
  web_url?: string;
  search_capabilities?: SearchCapabilities;
}

export type TerseCollection = Omit<Collection, "odp_version"> & {
  odp_version?: OdpVersion;
  detail_fields?: string[];
};

export type PricePreview =
  | { type: "free" }
  | { type: "fixed" | "starting_at"; amount: string; currency: string }
  | { type: "range"; minimum: string; maximum: string; currency: string }
  | { type: "metered"; amount: string; currency: string; unit: string }
  | { type: "quote" }
  | ({ type: string } & Record<string, unknown>);

export interface ActionRequest {
  content_type?: string;
  schema?: string;
}

export interface HttpActionTarget {
  href: string;
  method: "GET" | "POST";
  request?: ActionRequest;
  response_content_types?: string[];
}

export interface OpenApiActionTarget {
  url: string;
  operation_id: string;
}

export type OfferingAction = {
  id: string;
  rel: string;
  description?: string;
} & ({ http: HttpActionTarget; openapi?: never } | { openapi: OpenApiActionTarget; http?: never });

export interface Offering extends Record<string, unknown> {
  odp_version: OdpVersion;
  id: string;
  name: string;
  description?: string;
  language?: string;
  localizations?: string[];
  web_url?: string;
  collection_ids?: string[];
  price?: PricePreview;
  schema?: string;
  attributes?: Record<string, unknown>;
  actions?: OfferingAction[];
}

export type TerseOffering = Omit<Offering, "actions" | "odp_version"> & {
  odp_version?: OdpVersion;
  detail_fields?: string[];
  actions?: never;
};

export interface PageEnvelope<Item = unknown> extends Record<string, unknown> {
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
