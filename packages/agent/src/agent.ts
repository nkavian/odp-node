import {
  createDirectoryClient,
  type DirectoryEnvironment,
  type DirectorySearchRequest,
  type DirectoryService,
  type DirectoryTransport
} from "@offering-protocol/directory";
import type { TerseOffering } from "@offering-protocol/core";

import {
  createOdpServiceClient,
  type OdpServiceClient,
  type OfferingSearchOptions
} from "./client.js";

export type OdpServiceClientFactory = (
  service: DirectoryService
) => OdpServiceClient | Promise<OdpServiceClient>;

export interface OdpAgentOptions {
  directoryTransport?: DirectoryTransport;
  environment?: DirectoryEnvironment;
  serviceClient?: OdpServiceClientFactory;
}

export interface FederatedOfferingSearchRequest {
  services?: DirectorySearchRequest;
  offerings?: Omit<OfferingSearchOptions, "maxItems" | "maxPages" | "representation" | "signal">;
  concurrency?: number;
  maxOfferingsPerService?: number;
  maxServices?: number;
  signal?: AbortSignal;
}

export interface FederatedOfferingEvent {
  type: "offering";
  service: DirectoryService;
  offering: TerseOffering;
}

export interface FederatedIssueEvent {
  type: "issue";
  service: DirectoryService;
  issue: { message: string; cause: unknown };
}

export type FederatedDiscoveryEvent = FederatedOfferingEvent | FederatedIssueEvent;

export interface OdpAgent {
  readonly environment: DirectoryEnvironment;
  searchOfferingsAcrossServices(
    request?: FederatedOfferingSearchRequest
  ): AsyncIterable<FederatedDiscoveryEvent>;
}

export function createOdpAgent(options: OdpAgentOptions = {}): OdpAgent {
  const directory = createDirectoryClient({
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.directoryTransport === undefined ? {} : { transport: options.directoryTransport })
  });
  const createServiceClient: OdpServiceClientFactory =
    options.serviceClient ??
    ((service) => createOdpServiceClient({ serviceUrl: service.service_origin }));

  return {
    environment: directory.environment,
    searchOfferingsAcrossServices(request = {}) {
      return {
        async *[Symbol.asyncIterator]() {
          const maxServices = bounded(request.maxServices ?? 10, "maxServices", 1, 100);
          const maxOfferings = bounded(
            request.maxOfferingsPerService ?? 10,
            "maxOfferingsPerService",
            1,
            100
          );
          const concurrency = bounded(request.concurrency ?? 4, "concurrency", 1, 16);
          const services: DirectoryService[] = [];
          for await (const service of directory.searchServices(request.services, {
            maxItems: maxServices,
            ...(request.signal === undefined ? {} : { signal: request.signal })
          }).items)
            services.push(service);

          const schedule = createScheduler(concurrency);
          const results = services.map((service) =>
            schedule(() =>
              searchService(service, request.offerings ?? {}, maxOfferings, request.signal)
            )
          );
          for (const result of results) yield* await result;
        }
      };
    }
  };

  async function searchService(
    service: DirectoryService,
    request: NonNullable<FederatedOfferingSearchRequest["offerings"]>,
    maxItems: number,
    signal?: AbortSignal
  ): Promise<FederatedDiscoveryEvent[]> {
    try {
      const client = await createServiceClient(service);
      const options = {
        ...request,
        maxItems,
        representation: "terse" as const,
        ...(signal === undefined ? {} : { signal })
      };
      const sequence = sequenceFor(client, options);
      const events: FederatedDiscoveryEvent[] = [];
      for await (const offering of sequence.items)
        events.push({ type: "offering", service, offering });
      return events;
    } catch (cause) {
      if (signal?.aborted === true)
        throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      return [
        {
          type: "issue",
          service,
          issue: {
            message: cause instanceof Error ? cause.message : "Service discovery failed",
            cause
          }
        }
      ];
    }
  }
}

function createScheduler(concurrency: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <Value>(task: () => Promise<Value>): Promise<Value> => {
    if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

function sequenceFor(
  client: OdpServiceClient,
  request: OfferingSearchOptions & { representation: "terse" }
) {
  const hasSearch =
    request.query !== undefined ||
    request.filters !== undefined ||
    request.include_descendants !== undefined ||
    request.sort !== undefined ||
    request.refinements !== undefined;
  if (hasSearch) return client.searchOfferings(request);
  if (request.collection_id !== undefined)
    return client.listCollectionOfferings(request.collection_id, request);
  return client.listOfferings(request);
}

function bounded(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  return value;
}
