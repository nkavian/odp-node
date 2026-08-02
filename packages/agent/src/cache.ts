import type CachePolicy from "http-cache-semantics";

export type OdpCacheResourceClass =
  | "service-document"
  | "collection"
  | "offering"
  | "search"
  | "search-definition"
  | "attribute-schema"
  | "openapi";

export interface OdpCacheRecord<Value = unknown> {
  resourceClass: OdpCacheResourceClass;
  key: string;
  url: string;
  finalUrl: string;
  value: Value;
  policy: CachePolicy.CachePolicyObject;
}

export interface OdpCache {
  get(
    resourceClass: OdpCacheResourceClass,
    key: string
  ): Promise<OdpCacheRecord | undefined> | OdpCacheRecord | undefined;
  set(record: OdpCacheRecord): Promise<void> | void;
  delete(resourceClass: OdpCacheResourceClass, key: string): Promise<void> | void;
}

export function createInMemoryOdpCache(records: OdpCacheRecord[] = []): OdpCache {
  const values = new Map(
    records.map((record) => [address(record.resourceClass, record.key), clone(record)])
  );
  return {
    delete(resourceClass, key) {
      values.delete(address(resourceClass, key));
    },
    get(resourceClass, key) {
      const record = values.get(address(resourceClass, key));
      return record === undefined ? undefined : clone(record);
    },
    set(record) {
      values.set(address(record.resourceClass, record.key), clone(record));
    }
  };
}

function address(resourceClass: OdpCacheResourceClass, key: string): string {
  return `${resourceClass}\u0000${key}`;
}

function clone<Value>(record: OdpCacheRecord<Value>): OdpCacheRecord<Value> {
  return structuredClone(record);
}
