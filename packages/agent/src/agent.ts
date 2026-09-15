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
          // Every service search is started eagerly, so a consumer that stops after the first few
          // events would otherwise leave the rest running with nobody to observe them.
          const controller = new AbortController();
          const signal =
            request.signal === undefined
              ? controller.signal
              : AbortSignal.any([request.signal, controller.signal]);
          try {
            const services: DirectoryService[] = [];
            for await (const service of directory.searchServices(request.services, {
              maxItems: maxServices,
              signal
            }).items)
              services.push(service);

            const schedule = createScheduler(concurrency);
            // Settling each task as it is created means no scheduled promise can ever reject
            // without a handler — a consumer `break` used to crash the process with an unhandled
            // rejection once any in-flight service search failed.
            const results = services.map((service) =>
              schedule(() =>
                searchService(service, request.offerings ?? {}, maxOfferings, signal)
              ).then(
                (events) => ({ ok: true, events }) as const,
                (error: unknown) => ({ ok: false, error }) as const
              )
            );
            for (const result of results) {
              const settled = await result;
              if (!settled.ok) throw settled.error;
              yield* settled.events;
            }
          } finally {
            controller.abort();
          }
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
      // Only an actual abort ends the traversal. Testing `signal.aborted` alone reported any
      // failure that merely coincided with an abort as an AbortError and discarded its cause.
      if (isAbortError(cause)) throw cause;
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

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}

/**
 * Counting semaphore with direct hand-off: a finishing task passes its permit straight to the next
 * waiter instead of returning it to the pool. Decrementing first and waking a waiter afterwards let
 * a task submitted in between claim the freed slot and take the count over the limit.
 */
function createScheduler(concurrency: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  const acquire = async (): Promise<void> => {
    if (active < concurrency) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next === undefined) active -= 1;
    else next();
  };
  return async <Value>(task: () => Promise<Value>): Promise<Value> => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
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
