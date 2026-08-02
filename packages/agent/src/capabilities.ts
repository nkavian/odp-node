import type {
  FilterDefinition,
  PageEnvelope,
  SearchCapabilities,
  SortDefinition
} from "@offering-protocol/core";

import type { ServiceInspection } from "./inspection.js";

export interface CapabilityIssue {
  scope: "service" | "collection";
  kind: "filters" | "sorts";
  message: string;
}

export interface ResolvedSortDefinition extends SortDefinition {
  filters: FilterDefinition[];
}

export interface SearchCapabilityCatalog {
  filters: ReadonlyMap<string, FilterDefinition>;
  sorts: ReadonlyMap<string, ResolvedSortDefinition>;
  issues: CapabilityIssue[];
}

export interface CapabilityResolverOptions {
  inspection: ServiceInspection;
  collection: SearchCapabilities | undefined;
  loadPage(
    kind: "filters" | "sorts",
    href: string,
    signal?: AbortSignal
  ): Promise<PageEnvelope<FilterDefinition> | PageEnvelope<SortDefinition>>;
  signal?: AbortSignal;
}

export async function resolveSearchCapabilities(
  options: CapabilityResolverOptions
): Promise<SearchCapabilityCatalog> {
  const filters = new Map<string, FilterDefinition>();
  const sorts = new Map<string, SortDefinition>();
  const sortScopes = new Map<string, "service" | "collection">();
  const issues: CapabilityIssue[] = [];
  if (!options.inspection.capabilities.operations.includes("search-offerings")) {
    if (options.collection !== undefined)
      issues.push({
        scope: "collection",
        kind: "filters",
        message: "Collection search capabilities require the search-offerings operation."
      });
    return { filters, sorts: new Map(), issues };
  }
  for (const [scope, capabilities] of [
    ["service", options.inspection.document.search_capabilities],
    ["collection", options.collection]
  ] as const) {
    if (capabilities === undefined) continue;
    await addSource("filters", scope, capabilities.filters, filters, 1_024);
    await addSource("sorts", scope, capabilities.sorts, sorts, 128);
  }
  const resolvedSorts = new Map<string, ResolvedSortDefinition>();
  for (const [id, sort] of sorts) {
    const definitions = sort.keys.map((key) => filters.get(key.filter_id));
    if (definitions.some((definition) => definition === undefined)) {
      issues.push({
        scope: sortScopes.get(id) ?? "collection",
        kind: "sorts",
        message: `Sort ${id} references an unavailable filter.`
      });
      continue;
    }
    resolvedSorts.set(id, { ...sort, filters: definitions as FilterDefinition[] });
  }
  return { filters, sorts: resolvedSorts, issues };

  async function addSource<Value extends FilterDefinition | SortDefinition>(
    kind: "filters" | "sorts",
    scope: "service" | "collection",
    source: SearchCapabilities[typeof kind],
    target: Map<string, Value>,
    maximum: number
  ): Promise<void> {
    if (source === undefined) return;
    try {
      const values =
        "inline" in source
          ? source.inline
          : await linkedDefinitions<Value>(kind, source.linked.href);
      const duplicates = new Set<string>();
      const sourceIds = new Set<string>();
      for (const value of values) {
        if (target.has(value.id) || sourceIds.has(value.id)) duplicates.add(value.id);
        sourceIds.add(value.id);
      }
      for (const id of duplicates) {
        target.delete(id);
        if (kind === "sorts") sortScopes.delete(id);
      }
      const acceptedIds = new Set(values.map(({ id }) => id).filter((id) => !duplicates.has(id)));
      if (target.size + acceptedIds.size > maximum)
        throw new RangeError(`Effective ${kind} exceed their limit.`);
      for (const value of values) {
        if (duplicates.has(value.id)) continue;
        target.set(value.id, value as Value);
        if (kind === "sorts") sortScopes.set(value.id, scope);
      }
      if (duplicates.size > 0)
        issues.push({ scope, kind, message: `Duplicate ${kind}: ${[...duplicates].join(", ")}` });
    } catch (error) {
      issues.push({
        scope,
        kind,
        message: error instanceof Error ? error.message : `Invalid ${kind} source.`
      });
    }
  }

  async function linkedDefinitions<Value>(
    kind: "filters" | "sorts",
    href: string
  ): Promise<Value[]> {
    const values: Value[] = [];
    let next: string | undefined = href;
    const visited = new Set<string>();
    for (let pageNumber = 0; pageNumber < 16 && next !== undefined; pageNumber += 1) {
      if (visited.has(next)) throw new Error("ODP capability pagination loop detected");
      visited.add(next);
      const page = await options.loadPage(kind, next, options.signal);
      values.push(...(page.items as Value[]));
      next = page.next;
    }
    if (next !== undefined) throw new RangeError("ODP capability source exceeded 16 pages");
    return values;
  }
}
