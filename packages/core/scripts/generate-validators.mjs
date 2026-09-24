import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";

const schemasDirectory = new URL("../src/schemas/", import.meta.url);
const outputDirectory = new URL("../.generated/", import.meta.url);
const schemas = {
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
  strictTypes: false,
  code: { source: true, esm: true }
});
addFormats(ajv);
for (const file of (await readdir(schemasDirectory)).sort()) {
  if (file.endsWith(".schema.json")) {
    ajv.addSchema(JSON.parse(await readFile(new URL(file, schemasDirectory), "utf8")));
  }
}
const validators = Object.fromEntries(
  Object.entries(schemas).map(([name, schema]) => [
    name,
    `https://offeringprotocol.org/schemas/${schema}.schema.json`
  ])
);
await mkdir(outputDirectory, { recursive: true });
await writeGeneratedFile("validators.js", standaloneCode(ajv, validators));
await writeGeneratedFile(
  "validators.d.ts",
  'import type { ValidateFunction } from "ajv";\n' +
    Object.keys(schemas)
      .map((name) => `export declare const ${name}: ValidateFunction<unknown>;\n`)
      .join("")
);

async function writeGeneratedFile(name, content) {
  const temporary = new URL(`${name}.${randomUUID()}`, outputDirectory);
  await writeFile(temporary, content);
  await rename(temporary, new URL(name, outputDirectory));
}
