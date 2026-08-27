import { createOdpServiceClient } from "@offering-protocol/agent";
import type { DirectoryService, DirectoryTransport } from "@offering-protocol/directory";

export interface MockDirectory {
  transport: DirectoryTransport;
  unavailable: Array<{ serviceUrl: string; message: string }>;
  serviceUrlFor(serviceOrigin: string): string;
}

export async function createMockDirectory(serviceUrls: string[]): Promise<MockDirectory> {
  const services: DirectoryService[] = [];
  const localUrls = new Map<string, string>();
  const unavailable: Array<{ serviceUrl: string; message: string }> = [];

  for (const [index, serviceUrl] of serviceUrls.entries()) {
    try {
      const inspection = await createOdpServiceClient({
        serviceUrl,
        allowLocalNetwork: true,
        cachePartition: "mock-directory",
        signal: AbortSignal.timeout(2_000)
      }).inspect();
      const document = inspection.document;
      const serviceOrigin = `https://service-${index + 1}.mock-directory.example`;
      services.push({
        service_origin: serviceOrigin,
        name: document.name,
        description: document.description,
        language: document.language,
        localizations: document.localizations,
        ...(document.keywords === undefined ? {} : { keywords: document.keywords }),
        operations: [...document.operations],
        ...(document.protocols === undefined ? {} : { protocols: document.protocols }),
        indexed_at: "2026-08-02T00:00:00Z"
      });
      localUrls.set(serviceOrigin, serviceUrl);
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
      if (url.pathname !== "/v1/services/search" || init?.method !== "POST")
        return Promise.resolve(
          new Response("Mock directory supports Service search only", { status: 404 })
        );
      return Promise.resolve(
        new Response(JSON.stringify({ items: services }), {
          headers: { "content-type": "application/json" }
        })
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
