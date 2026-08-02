import type { URL } from "node:url";

import type { ResourceIdentity, ResourceType } from "./models.js";
import { deriveServiceOrigin, isLocalResourceIdentifier } from "./references.js";

export function createResourceIdentity(
  serviceDocumentUrl: string | URL,
  type: ResourceType,
  id: string
): ResourceIdentity {
  if (!isLocalResourceIdentifier(id)) throw new TypeError("Invalid ODP local resource identifier");
  return { service: deriveServiceOrigin(serviceDocumentUrl), type, id };
}

export function resourceIdentityKey(identity: ResourceIdentity): string {
  return `${identity.service}\u0000${identity.type}\u0000${identity.id}`;
}

export function resourceIdentitiesEqual(left: ResourceIdentity, right: ResourceIdentity): boolean {
  return left.service === right.service && left.type === right.type && left.id === right.id;
}
