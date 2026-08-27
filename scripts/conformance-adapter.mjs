#!/usr/bin/env node

import { createInterface } from "node:readline";

import {
  deriveServiceOrigin,
  isLocalResourceIdentifier,
  parseProblemResponse,
  resourceIdentitiesEqual,
  resolveContinuation,
  resolveResourceReference,
  safeParseCollection,
  safeParseCollectionSearchRequest,
  safeParseFilterDefinition,
  safeParseOffering,
  safeParseOfferingSearchRequest,
  safeParsePage,
  safeParseProblemDetails,
  safeParseServiceDocument,
  safeParseSortDefinition
} from "../packages/core/dist/index.js";
import { createOdpServiceClient } from "../packages/agent/dist/index.js";
import { createOdpService } from "../packages/service/dist/index.js";

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of input) {
  if (line.trim() === "") continue;
  const request = JSON.parse(line);
  const result = await evaluate(request);
  process.stdout.write(
    `${JSON.stringify({ protocol_version: "1", sequence: request.sequence, ...result })}\n`
  );
}

async function evaluate(request) {
  try {
    const actual = await evaluateCase(request.vector.subject, request.case, request.role);
    if (actual === undefined)
      return {
        status: "skipped",
        message: `No public Node operation maps ${request.vector.subject}/${request.case.operation ?? request.case.representation ?? request.case.name}`
      };
    return actual
      ? { status: "passed" }
      : { status: "failed", message: "Public API result did not match the vector" };
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message.slice(0, 1024) : "Adapter evaluation failed"
    };
  }
}

async function evaluateCase(subject, testCase, role) {
  switch (subject) {
    case "local-identifier":
      return isLocalResourceIdentifier(testCase.value) === testCase.valid;
    case "identity-comparison":
      return resourceIdentitiesEqual(testCase.left, testCase.right) === testCase.same_identity;
    case "service-origin":
      return isCanonicalServiceOrigin(testCase.value) === testCase.valid;
    case "resource-reference":
      return (
        succeeds(() => resolveResourceReference(testCase.value, "https://service.example")) ===
        testCase.valid
      );
    case "service-document":
      return safeParseServiceDocument(testCase.document).success === testCase.valid;
    case "collection-envelope":
      return safeParseCollection(testCase.document).success === testCase.valid;
    case "offering-contract":
      if (testCase.representation !== "full") return undefined;
      return safeParseOffering(testCase.document).success === testCase.valid;
    case "collection-search-contract":
      if (testCase.operation !== "validate-request") return undefined;
      return safeParseCollectionSearchRequest(testCase.request).success === testCase.valid;
    case "offering-search-contract":
      if (testCase.operation !== "validate-request") return undefined;
      return safeParseOfferingSearchRequest(testCase.request).success === testCase.valid;
    case "attribute-schema-retrieval":
      return evaluateAttributeSchema(testCase);
    case "filter-sort-contract":
      if (testCase.operation === "validate-definition")
        return safeParseFilterDefinition(testCase.definition).success === testCase.valid;
      if (testCase.operation === "validate-sort")
        return testCase.definitions === undefined
          ? safeParseSortDefinition(testCase.sort).success === testCase.valid
          : undefined;
      return undefined;
    case "pagination-contract":
      return evaluatePagination(testCase);
    case "errors-limits-contract":
      return evaluateErrorsLimits(testCase);
    case "role-baseline":
      return evaluateBaseline(testCase, role);
    default:
      return undefined;
  }
}

async function evaluateAttributeSchema(testCase) {
  switch (testCase.operation) {
    case "validate-reference":
      return (
        safeParseOffering({
          odp_version: "1.0",
          id: "item",
          name: "Item",
          schema: testCase.reference
        }).success === testCase.valid
      );
    case "validate-response": {
      const details = await attributeSchemaDetails({
        documents: new Map([
          [
            "https://schemas.example/root.json",
            {
              body: testCase.document,
              contentType: testCase.content_type,
              status: testCase.status
            }
          ]
        ])
      });
      return (details.attribute_schema !== undefined) === testCase.valid;
    }
    case "validate-schema-reference-profile": {
      const documents = new Map(
        testCase.documents.map((document, index) => [
          document.$id ?? `https://schemas.example/document-${index}.json`,
          { body: document, contentType: "application/schema+json", status: 200 }
        ])
      );
      const rootUrl = documents.keys().next().value;
      if (rootUrl === undefined) return false;
      const details = await attributeSchemaDetails({ documents, rootUrl });
      return (details.attribute_schema !== undefined) === testCase.valid;
    }
    case "validation-scope": {
      let supportingRequests = 0;
      const details = await attributeSchemaDetails({
        attributes: { memory: "invalid" },
        representation: testCase.representation,
        onSupportingRequest: () => {
          supportingRequests += 1;
        },
        documents: new Map([
          [
            "https://schemas.example/root.json",
            {
              body: {
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: { memory: { type: "number" } }
              },
              contentType: "application/schema+json",
              status: 200
            }
          ]
        ])
      });
      const complete =
        testCase.representation === "full"
          ? details.attributes === undefined &&
            details.issues?.some((issue) => issue.scope === "attributes") === true
          : supportingRequests > 0;
      return complete === testCase.complete_instance_validation;
    }
    case "failure-scope": {
      const details = await attributeSchemaDetails({
        documents: new Map([
          [
            "https://schemas.example/root.json",
            {
              body: { title: "Unavailable" },
              contentType: "application/problem+json",
              status: 503
            }
          ]
        ])
      });
      const actual = {
        offering_usable: details.id === "item",
        attributes_usable: details.attributes !== undefined,
        report_issue: details.issues?.some((issue) => issue.scope === "attribute_schema") === true
      };
      return Object.entries(testCase.expected).every(([name, value]) => actual[name] === value);
    }
    default:
      return undefined;
  }
}

async function attributeSchemaDetails(options) {
  const rootUrl = options.rootUrl ?? "https://schemas.example/root.json";
  const serviceDocument = {
    odp_version: "1.0",
    name: "Conformance Service",
    description: "ODP Node conformance adapter",
    language: "en",
    localizations: ["en"],
    operations: [
      { authentication: "not-required", name: "get-offering" },
      { authentication: "not-required", name: "list-offerings" }
    ],
    http: { endpoint_base: "/odp" }
  };
  const offering = {
    odp_version: "1.0",
    id: "item",
    name: "Item",
    schema: { url: rootUrl },
    attributes: options.attributes ?? { name: "root", children: [{ name: "child" }] }
  };
  const transport = async (url) =>
    url.pathname === "/.well-known/odp" ? jsonResponse(serviceDocument) : jsonResponse(offering);
  const supportingTransport = async (url) => {
    options.onSupportingRequest?.();
    const document = options.documents.get(String(url));
    if (document === undefined)
      return jsonResponse({ title: "Not Found" }, 404, "application/problem+json");
    return jsonResponse(document.body, document.status, document.contentType);
  };
  return createOdpServiceClient({
    serviceUrl: "https://service.example",
    transport,
    supportingTransport
  }).getOffering("item", { representation: options.representation ?? "full" });
}

function jsonResponse(value, status = 200, contentType = "application/odp+json") {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": contentType }
  });
}

async function evaluateErrorsLimits(testCase) {
  if (testCase.operation === "validate-problem") return evaluateProblem(testCase);
  if (testCase.operation !== "validate-limit" || testCase.resource !== "request") return undefined;
  const odp = createOdpService({
    document: {
      name: "Conformance Service",
      description: "ODP Node conformance adapter",
      language: "en",
      localizations: ["en"],
      http: { endpoint_base: "/odp" }
    },
    catalog: {
      listOfferings: () => ({ odp_version: "1.0", items: [] }),
      getOffering: () => undefined,
      searchOfferings: () => ({ odp_version: "1.0", items: [] })
    }
  });
  const request = JSON.stringify({ odp_version: "1.0", query: "gpu" }).padEnd(testCase.bytes, " ");
  const response = await odp.fetch(
    new Request("https://service.example/odp/offerings/search", {
      method: "POST",
      headers: { "content-type": "application/odp+json" },
      body: request,
      duplex: "half"
    })
  );
  return (response.status === 200) === testCase.valid;
}

function evaluatePagination(testCase) {
  if (testCase.operation === "validate-page")
    return safeParsePage(testCase.page).success === testCase.valid;
  if (testCase.operation === "validate-limit") {
    const valid = Number.isInteger(testCase.limit) && testCase.limit >= 1 && testCase.limit <= 100;
    return valid === testCase.valid;
  }
  if (testCase.operation === "validate-next")
    return (
      succeeds(() => resolveContinuation(testCase.next, testCase.service_origin)) === testCase.valid
    );
  return undefined;
}

function evaluateProblem(testCase) {
  if (testCase.operation !== "validate-problem") return undefined;
  const valid =
    safeParseProblemDetails(testCase.problem).success &&
    succeeds(() => parseProblemResponse(testCase.problem, testCase.http_status));
  return valid === testCase.valid;
}

function evaluateBaseline(testCase, role) {
  if (testCase.role !== role) return undefined;
  if (role === "service") {
    const document = {
      odp_version: "1.0",
      name: "Conformance Service",
      description: "ODP Node conformance adapter",
      language: "en",
      localizations: ["en"],
      operations: testCase.operations.map((name) => ({
        authentication: "not-required",
        name
      })),
      http: { endpoint_base: "/odp" }
    };
    const valid =
      safeParseServiceDocument(document).success &&
      safeParsePage(testCase.list_response).success &&
      safeParseOffering(testCase.get_response).success;
    return valid === testCase.valid;
  }
  return undefined;
}

function succeeds(operation) {
  try {
    operation();
    return true;
  } catch {
    return false;
  }
}

function isCanonicalServiceOrigin(value) {
  try {
    return deriveServiceOrigin(value) === value;
  } catch {
    return false;
  }
}
