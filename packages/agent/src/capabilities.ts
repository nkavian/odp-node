import type {
  FilterDefinition,
  PageEnvelope,
  SearchCapabilities,
  SortDefinition
} from "@offering-protocol/core";

import type { ServiceInspection } from "./inspection.js";

/** FLT-54: a linked capability page carries no more than 100 definitions. */
const MAX_DEFINITIONS_PER_PAGE = 100;
/** FLT-54: a complete linked source is no more than 16 pages. */
const MAX_SOURCE_PAGES = 16;
/** FLT-62: effective-catalog bounds after merging every source. */
const MAX_EFFECTIVE_FILTERS = 1_024;
const MAX_EFFECTIVE_SORTS = 128;

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

type CapabilitySource = NonNullable<SearchCapabilities["filters"] | SearchCapabilities["sorts"]>;

function inlineDefinitions(source: CapabilitySource): { id: string }[] | undefined {
  // `"inline" in source` is also true for `{ inline: undefined, linked: {...} }`, which would make
  // the caller iterate `undefined`. Test the value, not the key.
  const candidate = (source as { inline?: unknown }).inline;
  return Array.isArray(candidate) ? (candidate as { id: string }[]) : undefined;
}

function linkedHref(source: CapabilitySource): string | undefined {
  const candidate = (source as { linked?: { href?: unknown } }).linked;
  return typeof candidate?.href === "string" ? candidate.href : undefined;
}

export async function resolveSearchCapabilities(
  options: CapabilityResolverOptions
): Promise<SearchCapabilityCatalog> {
  const filters = new Map<string, FilterDefinition>();
  const sorts = new Map<string, SortDefinition>();
  const sortScopes = new Map<string, "service" | "collection">();
  const issues: CapabilityIssue[] = [];
  if (!options.inspection.capabilities.operations.some(({ name }) => name === "search-offerings")) {
    // FLT-49: `search_capabilities` must not appear at all unless `search-offerings` is advertised.
    // Report whichever scope actually carried one rather than silently returning an empty catalog.
    if (options.inspection.document.search_capabilities !== undefined)
      issues.push({
        scope: "service",
        kind: "filters",
        message: "Service search capabilities require the search-offerings operation."
      });
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
    await addSource("filters", scope, capabilities.filters, filters, MAX_EFFECTIVE_FILTERS);
    await addSource("sorts", scope, capabilities.sorts, sorts, MAX_EFFECTIVE_SORTS);
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
      const inline = inlineDefinitions(source);
      let values: Value[];
      if (inline !== undefined) values = inline as Value[];
      else {
        const href = linkedHref(source);
        if (href === undefined) throw new TypeError(`Invalid ${kind} capability source.`);
        // The remaining budget goes down with the request so paging stops at the page that
        // overflows the effective catalog instead of buffering the whole source first (FLT-58).
        values = await linkedDefinitions<Value>(kind, href, maximum - target.size);
      }

      // FLT-55: a source is atomic and must enforce its own uniqueness. A repeat *within* one
      // source invalidates that whole source rather than quarantining a single identifier.
      const sourceIds = new Set<string>();
      for (const value of values) {
        if (sourceIds.has(value.id))
          throw new TypeError(`Duplicate ${kind} identifier ${value.id} within one source.`);
        sourceIds.add(value.id);
      }

      // FLT-64/FLT-65: an identifier published by two effective sources is quarantined — neither
      // copy wins — but that removes only the identifier, not the rest of the earlier source.
      const crossSource = [...sourceIds].filter((id) => target.has(id));
      const accepted = values.filter((value) => !crossSource.includes(value.id));

      // FLT-62: check the bound before mutating, so a source that overflows leaves every earlier
      // valid source exactly as it was.
      if (target.size - crossSource.length + accepted.length > maximum)
        throw new RangeError(`Effective ${kind} exceed their limit.`);

      for (const id of crossSource) {
        target.delete(id);
        if (kind === "sorts") sortScopes.delete(id);
      }
      for (const value of accepted) {
        target.set(value.id, value);
        if (kind === "sorts") sortScopes.set(value.id, scope);
      }
      if (crossSource.length > 0)
        issues.push({ scope, kind, message: `Duplicate ${kind}: ${crossSource.join(", ")}` });
    } catch (error) {
      // FLT-57: a failed or invalid source is omitted from the catalog and reported as a scoped
      // issue; unrelated sources stay usable.
      issues.push({
        scope,
        kind,
        message: error instanceof Error ? error.message : `Invalid ${kind} source.`
      });
    }
  }

  async function linkedDefinitions<Value>(
    kind: "filters" | "sorts",
    href: string,
    budget: number
  ): Promise<Value[]> {
    const values: Value[] = [];
    let next: string | undefined = href;
    const visited = new Set<string>();
    for (let pageNumber = 0; pageNumber < MAX_SOURCE_PAGES && next !== undefined; pageNumber += 1) {
      if (visited.has(next)) throw new Error("ODP capability pagination loop detected");
      visited.add(next);
      const page = await options.loadPage(kind, next, options.signal);
      if (page.items.length > MAX_DEFINITIONS_PER_PAGE)
        throw new RangeError(`ODP capability page cannot contain more than 100 ${kind}`);
      values.push(...(page.items as Value[]));
      if (values.length > budget) throw new RangeError(`Effective ${kind} exceed their limit.`);
      next = page.next;
    }
    // FLT-59: page 16 carrying `next` means page 17 is never retrieved and the source is discarded.
    if (next !== undefined) throw new RangeError("ODP capability source exceeded 16 pages");
    return values;
  }
}
