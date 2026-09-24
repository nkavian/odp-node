import { createOdpService } from "@offering-protocol/service";

const offering = {
  odp_version: "1.0" as const,
  id: "incident-plan",
  name: "Incident Response Plan",
  description: "A downloadable incident-response planning template.",
  price: { type: "free" as const },
  actions: [
    {
      authentication: "not-required" as const,
      id: "download",
      rel: "download" as const,
      http: {
        method: "GET" as const,
        href: "/downloads/incident-plan.txt",
        response_content_types: ["text/plain"]
      }
    }
  ]
};

const service = createOdpService({
  document: {
    name: "Cloudflare Example Store",
    description: "A public ODP catalog served by a Cloudflare Worker.",
    language: "en",
    localizations: ["en"],
    http: { endpoint_base: "/odp" }
  },
  catalog: {
    listOfferings: (request) => ({
      odp_version: "1.0",
      items: [representOffering(request.representation)]
    }),
    getOffering: (id, request) =>
      id === offering.id ? representOffering(request.representation) : undefined
  }
});

function representOffering(representation: "terse" | "full") {
  if (representation === "full") return offering;
  return {
    odp_version: offering.odp_version,
    id: offering.id,
    name: offering.name,
    price: offering.price
  };
}

export default {
  fetch(request: Request): Promise<Response> | Response {
    if (new URL(request.url).pathname === "/downloads/incident-plan.txt") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
      }
      return new Response(request.method === "HEAD" ? null : "Incident Response Plan\n", {
        headers: { "content-type": "text/plain" }
      });
    }
    return service.fetch(request);
  }
};
