import type { PageEnvelope } from "./models.js";

export interface PaginationOptions {
  maxPages?: number;
}

export interface PageLoader<Item> {
  (next: string): Promise<PageEnvelope<Item>>;
}

export async function* iteratePages<Item>(
  firstPage: PageEnvelope<Item>,
  loadPage: PageLoader<Item>,
  options: PaginationOptions = {}
): AsyncGenerator<PageEnvelope<Item>> {
  const maxPages = options.maxPages ?? 16;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 16) {
    throw new RangeError("maxPages must be an integer from 1 through 16");
  }

  const visited = new Set<string>();
  let page = firstPage;
  for (let count = 0; count < maxPages; count += 1) {
    yield page;
    if (page.next === undefined) return;
    if (visited.has(page.next)) throw new Error("ODP pagination loop detected");
    visited.add(page.next);
    page = await loadPage(page.next);
  }
  if (page.next !== undefined)
    throw new RangeError("ODP pagination exceeded the 16-page traversal limit");
}

export async function* iterateItems<Item>(
  firstPage: PageEnvelope<Item>,
  loadPage: PageLoader<Item>,
  options?: PaginationOptions
): AsyncGenerator<Item> {
  for await (const page of iteratePages(firstPage, loadPage, options)) {
    yield* page.items;
  }
}
