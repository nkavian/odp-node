import { randomUUID } from "node:crypto";

import { createOdpServiceClient } from "@offering-protocol/agent";
import type {
  DirectoryIndexedService,
  DirectoryResult,
  DirectoryTransport
} from "@offering-protocol/directory";

export interface MockDirectory {
  transport: DirectoryTransport;
  unavailable: Array<{ serviceUrl: string; message: string }>;
  serviceUrlFor(serviceOrigin: string): string;
}

export async function createMockDirectory(serviceUrls: string[]): Promise<MockDirectory> {
  const services: DirectoryIndexedService[] = [];
  const items: DirectoryResult[] = [];
  const localUrls = new Map<string, string>();
  const unavailable: Array<{ serviceUrl: string; message: string }> = [];

  for (const [index, serviceUrl] of serviceUrls.entries()) {
    try {
      const client = createOdpServiceClient({
        serviceUrl,
        allowLocalNetwork: true,
        cachePartition: "mock-directory",
        signal: AbortSignal.timeout(2_000)
      });
      const inspection = await client.inspect();
      const document = inspection.document;
      const serviceOrigin = `https://service-${index + 1}.mock-directory.example`;
      const service: DirectoryIndexedService = {
        service_id: randomUUID(),
        service_origin: serviceOrigin,
        name: document.name,
        description: document.description,
        language: document.language,
        localizations: document.localizations,
        ...(document.keywords === undefined ? {} : { keywords: document.keywords }),
        operations: [...document.operations],
        ...(document.protocols === undefined ? {} : { protocols: document.protocols }),
        indexed_at: "2026-08-02T00:00:00Z"
      };
      services.push(service);
      items.push({ type: "service", service, indexed_at: service.indexed_at });
      localUrls.set(serviceOrigin, serviceUrl);
      if (
        ["list-collections", "get-collection"].every((name) =>
          document.operations.some(
            (operation) => operation.name === name && operation.authentication !== "required"
          )
        )
      ) {
        for await (const collection of client.listCollections({ maxPages: 1, maxItems: 2 }).items) {
          items.push({
            type: "collection",
            service,
            indexed_at: service.indexed_at,
            collection: {
              id: collection.id,
              name: collection.name,
              ...(collection.description === undefined
                ? {}
                : { description: collection.description })
            }
          });
        }
      }
    } catch (error) {
      unavailable.push({
        serviceUrl,
        message: error instanceof Error ? error.message : "Inspection failed"
      });
    }
  }

  return {
    unavailable,
    transport: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== "https://sandbox.inflowpay.ai")
        return Promise.resolve(
          new Response("Mock directory received the wrong origin", { status: 500 })
        );
      if (
        !["/v1/services/search", "/v1/directory/search"].includes(url.pathname) ||
        init?.method !== "POST"
      )
        return Promise.resolve(
          new Response("Mock directory supports search requests only", { status: 404 })
        );
      return Promise.resolve(
        new Response(
          JSON.stringify({ items: url.pathname === "/v1/services/search" ? services : items }),
          {
            headers: { "content-type": "application/json" }
          }
        )
      );
    },
    serviceUrlFor(serviceOrigin) {
      const serviceUrl = localUrls.get(serviceOrigin);
      if (serviceUrl === undefined)
        throw new Error(`Mock directory has no local URL for ${serviceOrigin}`);
      return serviceUrl;
    }
  };
}
