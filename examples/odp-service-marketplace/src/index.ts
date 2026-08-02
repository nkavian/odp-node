import { serveOdp } from "@offering-protocol/examples-shared";
import {
  parseOfferingSearchRequest,
  type Offering,
  type OfferingSearchRequest,
  type PageEnvelope,
  type TerseOffering
} from "@offering-protocol/core";
import {
  createOdpService,
  OdpServiceError,
  type OdpCatalog,
  type OdpCatalogRequest
} from "@offering-protocol/service";

const catalogSize = 10_000_000;

const catalog = {
  listOfferings(request) {
    return page(request);
  },
  searchOfferings(query, request) {
    const state = query ?? decodeCursor(request.cursor).query;
    return page(request, state);
  },
  getOffering(id, request) {
    const index = offeringIndex(id);
    if (index === undefined) return undefined;
    return offering(index, request.representation === "full");
  }
} satisfies OdpCatalog;

const service = createOdpService({
  document: {
    name: "Marketplace Example",
    description: "A storage-style virtual catalog containing ten million GPU rentals.",
    language: "en",
    localizations: ["en"],
    keywords: ["compute", "gpu", "marketplace"],
    http: { endpoint_base: "/odp" }
  },
  catalog
});

serveOdp(service, "Marketplace ODP Service", (request) =>
  new URL(request.url).pathname === "/schemas/gpu.json"
    ? new Response(
        JSON.stringify({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          required: ["accelerator", "region"],
          properties: {
            accelerator: { enum: ["A100", "H100"] },
            region: { type: "string" }
          },
          additionalProperties: false
        }),
        { headers: { "content-type": "application/schema+json" } }
      )
    : undefined
);

function page(
  request: OdpCatalogRequest,
  query?: OfferingSearchRequest
): PageEnvelope<Offering | TerseOffering> {
  if (query?.query !== undefined && !"gpu compute accelerator".includes(query.query.toLowerCase()))
    return { odp_version: "1.0", items: [] };
  const cursor = decodeCursor(request.cursor);
  const offset = cursor.offset;
  const limit = request.limit ?? 50;
  const end = Math.min(offset + limit, catalogSize);
  const items = Array.from({ length: end - offset }, (_, item) =>
    offering(offset + item, request.representation === "full")
  );
  return {
    odp_version: "1.0",
    items,
    ...(end === catalogSize
      ? {}
      : {
          next: `${new URL(request.request.url).pathname}?${new URLSearchParams({
            cursor: encodeCursor({ offset: end, ...(query === undefined ? {} : { query }) }),
            representation: request.representation,
            limit: String(limit)
          }).toString()}`
        })
  };
}

function offering(index: number, full: boolean): Offering | TerseOffering {
  const id = `gpu-${String(index).padStart(8, "0")}`;
  const base = {
    id,
    name: `GPU rental ${index}`,
    description: "Hourly accelerator capacity",
    price: { type: "metered" as const, amount: "2.50", currency: "USD", unit: "hour" }
  };
  return full
    ? {
        odp_version: "1.0",
        ...base,
        schema: { url: "/schemas/gpu.json" },
        attributes: { accelerator: index % 2 === 0 ? "H100" : "A100", region: `us-${index % 4}` }
      }
    : base;
}

function offeringIndex(id: string): number | undefined {
  const match = /^gpu-([0-9]{8})$/.exec(id);
  if (match?.[1] === undefined) return undefined;
  const index = Number(match[1]);
  return index < catalogSize ? index : undefined;
}

interface CursorState {
  offset: number;
  query?: OfferingSearchRequest;
}

function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state)).toString("base64url");
}

function decodeCursor(cursor: string | undefined): CursorState {
  if (cursor === undefined) return { offset: 0 };
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("offset" in value) ||
      !Number.isInteger(value.offset) ||
      typeof value.offset !== "number" ||
      value.offset < 0 ||
      value.offset >= catalogSize
    )
      throw new TypeError();
    return {
      offset: value.offset,
      ...("query" in value ? { query: parseOfferingSearchRequest(value.query) } : {})
    };
  } catch {
    throw new OdpServiceError(410, "CONTINUATION_EXPIRED", "Continuation is unavailable");
  }
}
