import {
  resolveResourceReference,
  type ActionRequest,
  type OfferingAction,
  type PricePreview,
  type SchemaReference
} from "@offering-protocol/core";

import type { JsonSchema } from "./schemas.js";

export interface OfferingIssue {
  scope: "attribute_schema" | "attributes" | "action";
  message: string;
  action_id?: string;
}

export type DiscoveredAction = {
  id: string;
  rel: string;
  description?: string;
} & (
  | {
      target: {
        kind: "http";
        url: string;
        method: "GET" | "POST";
        request?: ActionRequest;
        response_content_types?: string[];
      };
    }
  | {
      target: { kind: "openapi"; url: string; operation_id: string };
    }
);

export type DiscoveredHttpAction = Extract<DiscoveredAction, { target: { kind: "http" } }>;
export type DiscoveredOpenApiAction = Extract<DiscoveredAction, { target: { kind: "openapi" } }>;

export interface OfferingDetails extends Record<string, unknown> {
  odp_version: "1.0";
  id: string;
  name: string;
  description?: string;
  language?: string;
  localizations?: string[];
  web_url?: string;
  collection_ids?: string[];
  price?: PricePreview;
  schema?: SchemaReference;
  attributes?: Record<string, unknown>;
  attribute_schema?: JsonSchema;
  actions?: DiscoveredAction[];
  issues?: OfferingIssue[];
}

export interface ResolvedHttpAction {
  action: DiscoveredHttpAction;
  request_schema?: JsonSchema;
}

export interface ResolvedOpenApiAction {
  action: DiscoveredOpenApiAction;
  openapi_document: Record<string, unknown>;
  operation: Record<string, unknown>;
}

export type ResolvedAction = ResolvedHttpAction | ResolvedOpenApiAction;

export function normalizeActions(
  actions: OfferingAction[] | undefined,
  serviceOrigin: string
): { actions?: DiscoveredAction[]; issues: OfferingIssue[] } {
  if (actions === undefined) return { issues: [] };
  const duplicates = duplicateIds(actions);
  const issues = [...duplicates].map((id) => ({
    scope: "action" as const,
    action_id: id,
    message: `Duplicate Action identifier ${id}`
  }));
  const normalized: DiscoveredAction[] = [];
  for (const action of actions) {
    if (duplicates.has(action.id)) continue;
    try {
      const common = {
        id: action.id,
        rel: action.rel,
        ...(action.description === undefined ? {} : { description: action.description })
      };
      if (action.http !== undefined) {
        normalized.push({
          ...common,
          target: {
            kind: "http",
            url: String(resolveResourceReference(action.http.href, serviceOrigin)),
            method: action.http.method,
            ...(action.http.request === undefined ? {} : { request: action.http.request }),
            ...(action.http.response_content_types === undefined
              ? {}
              : { response_content_types: action.http.response_content_types })
          }
        });
      } else {
        normalized.push({
          ...common,
          target: {
            kind: "openapi",
            url: String(resolveResourceReference(action.openapi.url, serviceOrigin)),
            operation_id: action.openapi.operation_id
          }
        });
      }
    } catch (error) {
      issues.push({
        scope: "action",
        action_id: action.id,
        message: error instanceof Error ? error.message : "Invalid Action target"
      });
    }
  }
  return {
    ...(normalized.length === 0 ? {} : { actions: normalized }),
    issues
  };
}

function duplicateIds(actions: OfferingAction[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const { id } of actions) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return duplicates;
}
