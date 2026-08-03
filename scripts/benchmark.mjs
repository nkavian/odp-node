#!/usr/bin/env node

import { performance } from "node:perf_hooks";

import { iterateItems, parseServiceDocument } from "../packages/core/dist/index.js";
import { createOdpService, createStaticCatalog } from "../packages/service/dist/index.js";

const results = [];
const document = {
  odp_version: "1.0",
  name: "Benchmark Service",
  description: "A reproducible ODP performance fixture.",
  language: "en",
  localizations: ["en"],
  operations: [
    { authentication: "not-required", name: "get-offering" },
    { authentication: "not-required", name: "list-offerings" }
  ],
  http: { endpoint_base: "/odp" }
};

await measure("Service Document validation", "operations/s", 50_000, 500_000, () => {
  parseServiceDocument(document);
});

await measure(
  "Bounded pagination",
  "items/s",
  250_000,
  1_000,
  async () => {
    let count = 0;
    for await (const _item of iterateItems(
      { odp_version: "1.0", items: Array.from({ length: 100 }, (_, id) => id), next: "/2" },
      async (next) => ({
        odp_version: "1.0",
        items: Array.from({ length: 100 }, (_, id) => id),
        ...(next === "/16" ? {} : { next: `/${Number(next.slice(1)) + 1}` })
      })
    ))
      count += 1;
    if (count !== 1_600) throw new Error(`Pagination benchmark consumed ${count} items`);
  },
  1_600
);

const offerings = Array.from({ length: 100 }, (_, index) => ({
  odp_version: "1.0",
  id: `offering-${index}`,
  name: `Offering ${index}`
}));
const staticService = createOdpService({
  document: { ...document, odp_version: undefined, operations: undefined },
  catalog: createStaticCatalog({ offerings })
});
await measure("Static catalog request", "requests/s", 1_000, 5_000, async () => {
  const response = await staticService.fetch(
    new Request("https://service.example/odp/offerings?limit=25")
  );
  if (!response.ok) throw new Error(`Static catalog benchmark returned HTTP ${response.status}`);
});

const storageService = createOdpService({
  document: { ...document, odp_version: undefined, operations: undefined },
  catalog: {
    listOfferings: ({ limit = 50 }) => ({
      odp_version: "1.0",
      items: Array.from({ length: limit }, (_, index) => ({
        id: `virtual-${index}`,
        name: `Virtual Offering ${index}`
      })),
      next: "/odp/offerings?cursor=opaque"
    }),
    getOffering: (id) => ({ odp_version: "1.0", id, name: id })
  }
});
await measure("Storage-backed request", "requests/s", 1_000, 5_000, async () => {
  const response = await storageService.fetch(
    new Request("https://service.example/odp/offerings?limit=25")
  );
  if (!response.ok) throw new Error(`Storage benchmark returned HTTP ${response.status}`);
});

process.stdout.write("\n| Benchmark | Result | Budget |\n| --- | ---: | ---: |\n");
for (const result of results) {
  process.stdout.write(
    `| ${result.name} | ${Math.floor(result.rate).toLocaleString("en-US")} ${result.unit} | ${result.minimum.toLocaleString("en-US")} ${result.unit} |\n`
  );
}

const failures = results.filter(({ rate, minimum }) => rate < minimum);
if (failures.length > 0) {
  for (const failure of failures)
    process.stderr.write(
      `${failure.name}: ${Math.floor(failure.rate)} ${failure.unit} is below ${failure.minimum}\n`
    );
  process.exitCode = 1;
}

async function measure(name, unit, minimum, iterations, operation, unitsPerIteration = 1) {
  for (let index = 0; index < Math.min(iterations, 100); index += 1) await operation();
  const start = performance.now();
  for (let index = 0; index < iterations; index += 1) await operation();
  const elapsedSeconds = (performance.now() - start) / 1_000;
  results.push({
    name,
    unit,
    minimum,
    rate: (iterations * unitsPerIteration) / elapsedSeconds
  });
}
