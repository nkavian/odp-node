import { readdirSync, readFileSync } from "node:fs";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import * as generated from "../../.generated/validators.js";

const schemaNames = {
  collection: "collection",
  collectionSearchRequest: "collection-search-request",
  filterDefinition: "filter-definition",
  filterDefinitionPage: "filter-definition-page",
  offering: "offering",
  offeringSearchRequest: "offering-search-request",
  offeringSearchResponse: "offering-search-response",
  page: "page-envelope",
  problemDetails: "problem-details",
  resourceIdentity: "resource-identity",
  serviceDocument: "service-document",
  sortDefinition: "sort-definition",
  sortDefinitionPage: "sort-definition-page"
};
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
  strictTypes: false
});
addFormats.default(ajv);
const directory = new URL("../../src/schemas/", import.meta.url);
for (const file of readdirSync(directory).sort()) {
  if (file.endsWith(".schema.json")) {
    const schema: unknown = JSON.parse(readFileSync(new URL(file, directory), "utf8"));
    if (typeof schema !== "object" || schema === null) throw new Error("Expected a schema object");
    ajv.addSchema(schema);
  }
}

const documents: Record<string, unknown>[] = [
  {
    odp_version: "1.0",
    name: "Example",
    description: "An example Service.",
    language: "en",
    localizations: ["en"],
    operations: [
      { authentication: "not-required", name: "list-offerings" },
      { authentication: "not-required", name: "get-offering" }
    ],
    http: { endpoint_base: "/odp" }
  },
  { odp_version: "1.0", id: "example", name: "Example" },
  { odp_version: "1.0", items: [] },
  { odp_version: "1.0", query: "plants" },
  {
    status: 400,
    code: "INVALID_REQUEST",
    title: "Invalid request",
    type: "https://offeringprotocol.org/problems/invalid-request"
  },
  { service: "https://example.com", type: "offering", id: "example" },
  {
    id: "price",
    title: "Price",
    description: "Filter by price.",
    type: "number",
    operators: ["eq"]
  },
  {
    id: "by-price",
    title: "By price",
    description: "Sort by price.",
    keys: [{ filter_id: "price", direction: "ascending", missing: "last" }]
  }
];
const inputs: unknown[] = [undefined, null, false, 0, "", [], {}, ...documents];
for (const document of documents) {
  for (const key of Object.keys(document)) {
    const omitted = { ...document };
    delete omitted[key];
    inputs.push(omitted);
    for (const value of [null, false, -1, [], ""]) inputs.push({ ...document, [key]: value });
  }
}

describe("precompiled schema validators", () => {
  it("exports every core validator", () => {
    expect(Object.keys(generated).sort()).toEqual(Object.keys(schemaNames).sort());
  });

  for (const name of Object.keys(schemaNames) as (keyof typeof schemaNames)[]) {
    it(`preserves ${name} validation results and errors`, () => {
      const runtime = ajv.getSchema(
        `https://offeringprotocol.org/schemas/${schemaNames[name]}.schema.json`
      );
      if (runtime === undefined) throw new Error(`Missing schema: ${name}`);
      expect(documents.some((document) => runtime(document) === true)).toBe(true);
      for (const input of inputs) {
        const value = structuredClone(input);
        expect(generated[name](value)).toBe(runtime(input));
        expect(generated[name].errors).toEqual(runtime.errors);
        expect(value).toEqual(input);
      }
    });
  }
});
