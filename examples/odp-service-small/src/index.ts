import { serveOdp } from "@offering-protocol/examples-shared";
import { createOdpService, createStaticCatalog } from "@offering-protocol/service";

const service = createOdpService({
  document: {
    name: "Small Example Store",
    description: "A small static catalog configured entirely in memory.",
    language: "en",
    localizations: ["en"],
    keywords: ["digital", "templates"],
    http: { endpoint_base: "/odp" }
  },
  catalog: createStaticCatalog({
    collections: [
      { odp_version: "1.0", id: "templates", name: "Templates", description: "Free templates" }
    ],
    offerings: [
      {
        odp_version: "1.0",
        id: "incident-plan",
        name: "Incident Response Plan",
        description: "A downloadable incident-response planning template.",
        collection_ids: ["templates"],
        price: { type: "free" },
        actions: [
          {
            id: "download",
            rel: "download",
            http: {
              method: "GET",
              href: "/downloads/incident-plan.txt",
              response_content_types: ["text/plain"]
            }
          }
        ]
      },
      {
        odp_version: "1.0",
        id: "architecture-review",
        name: "Architecture Review",
        description: "A one-time architecture review.",
        price: { type: "starting_at", amount: "500", currency: "USD" }
      }
    ]
  })
});

serveOdp(service, "Small ODP Service", (request) =>
  new URL(request.url).pathname === "/downloads/incident-plan.txt"
    ? new Response("Incident Response Plan\n", { headers: { "content-type": "text/plain" } })
    : undefined
);
