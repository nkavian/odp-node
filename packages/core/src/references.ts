import { URL } from "node:url";

import type { OdpOperation } from "./models.js";

const LOCAL_IDENTIFIER = /^(?!\.{1,2}$)[A-Za-z0-9._~-]{1,128}$/u;

export const ODP_OPERATION_METHODS = {
  "list-collections": "GET",
  "search-collections": "POST",
  "get-collection": "GET",
  "list-collection-offerings": "GET",
  "list-offerings": "GET",
  "search-offerings": "POST",
  "get-offering": "GET"
} as const satisfies Record<OdpOperation, "GET" | "POST">;

const RESOURCE_OPERATIONS = new Set<OdpOperation>([
  "get-collection",
  "list-collection-offerings",
  "get-offering"
]);

function fixedOperationPath(operation: OdpOperation, id?: string): string {
  if (RESOURCE_OPERATIONS.has(operation)) {
    if (id === undefined || !isLocalResourceIdentifier(id)) {
      throw new TypeError(`${operation} requires a valid local resource identifier`);
    }
  } else if (id !== undefined) {
    throw new TypeError(`${operation} does not accept a resource identifier`);
  }

  switch (operation) {
    case "list-collections":
      return "/collections";
    case "search-collections":
      return "/collections/search";
    case "get-collection":
      return `/collections/${id}`;
    case "list-collection-offerings":
      return `/collections/${id}/offerings`;
    case "list-offerings":
      return "/offerings";
    case "search-offerings":
      return "/offerings/search";
    case "get-offering":
      return `/offerings/${id}`;
  }
}

export function isLocalResourceIdentifier(value: string): boolean {
  return LOCAL_IDENTIFIER.test(value);
}

export function deriveServiceOrigin(serviceDocumentUrl: string | URL): string {
  const url = new URL(serviceDocumentUrl);
  if (url.username !== "" || url.password !== "")
    throw new TypeError("Service URL cannot contain user information");
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new TypeError("Service URL must use HTTPS except on loopback hosts");
  }
  return url.origin;
}

export function resolveResourceReference(reference: string, serviceOrigin: string | URL): URL {
  if (
    (!reference.startsWith("/") || reference.startsWith("//")) &&
    !reference.startsWith("https://") &&
    !reference.startsWith("http://localhost") &&
    !reference.startsWith("http://127.0.0.1") &&
    !reference.startsWith("http://[::1]")
  ) {
    throw new TypeError(
      "ODP resource references must be origin-relative absolute paths or secure absolute URLs"
    );
  }
  const origin = new URL(serviceOrigin);
  const resolved = new URL(reference, origin);
  if (resolved.hash !== "") throw new TypeError("ODP resource references cannot contain fragments");
  if (resolved.username !== "" || resolved.password !== "") {
    throw new TypeError("ODP resource references cannot contain user information");
  }
  const loopback =
    resolved.hostname === "localhost" ||
    resolved.hostname === "127.0.0.1" ||
    resolved.hostname === "[::1]";
  if (resolved.protocol !== "https:" && !(resolved.protocol === "http:" && loopback)) {
    throw new TypeError("ODP resource references must use HTTPS except on loopback hosts");
  }
  return resolved;
}

export function resolveContinuation(reference: string, serviceOrigin: string | URL): URL {
  const origin = new URL(serviceOrigin);
  const resolved = resolveResourceReference(reference, origin);
  if (resolved.origin !== origin.origin)
    throw new TypeError("ODP continuation references must remain on the Service origin");
  return resolved;
}

export function buildOperationUrl(
  endpointBase: string,
  operationPath: string,
  serviceOrigin: string | URL
): URL {
  if (!endpointBase.startsWith("/") || endpointBase.startsWith("//")) {
    throw new TypeError("ODP endpoint base must be an origin-relative absolute path");
  }
  if (!operationPath.startsWith("/"))
    throw new TypeError("ODP operation path must begin with a slash");
  const base = endpointBase.endsWith("/") ? endpointBase.slice(0, -1) : endpointBase;
  return resolveResourceReference(`${base}${operationPath}`, serviceOrigin);
}

export function buildOdpOperationUrl(
  endpointBase: string,
  operation: OdpOperation,
  serviceOrigin: string | URL,
  id?: string
): URL {
  return buildOperationUrl(endpointBase, fixedOperationPath(operation, id), serviceOrigin);
}
