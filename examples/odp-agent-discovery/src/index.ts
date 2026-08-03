import { createOdpServiceClient } from "@offering-protocol/agent";
import { createDirectoryClient } from "@offering-protocol/directory";
import { loadExampleEnvironment } from "@offering-protocol/examples-shared";

import { createMockDirectory } from "./mock-directory.js";

loadExampleEnvironment();

const configuredUrls = (
  process.env["SERVICE_URLS"] ??
  "http://127.0.0.1:4101,http://127.0.0.1:4102,http://127.0.0.1:4103,http://127.0.0.1:4104"
)
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value.length > 0);
const mock = await createMockDirectory(configuredUrls);

heading("MOCK DIRECTORY");
process.stdout.write(
  "This example uses an in-process mock of the sandbox directory API. It is not contacting the deployed directory.\n"
);
for (const unavailable of mock.unavailable)
  process.stdout.write(
    `Skipped unreachable Service: ${unavailable.serviceUrl}\n  Reason: ${unavailable.message}\n`
  );

const directory = createDirectoryClient({ environment: "sandbox", transport: mock.transport });
let discovered = 0;
for await (const service of directory.searchServices().items) {
  discovered += 1;
  const serviceUrl = mock.serviceUrlFor(service.service_origin);
  const client = createOdpServiceClient({
    serviceUrl,
    cachePartition: "example-public",
    initialPageSize: 2
  });

  heading(`SERVICE ${discovered}: ${service.name}`);
  print("Mock directory entry", service);

  const inspection = await client.inspect();
  print("ODP Service document", inspection.document);

  const page = await client.listOfferings().pages[Symbol.asyncIterator]().next();
  if (page.done) {
    process.stdout.write("Offering list is empty.\n");
    continue;
  }
  print("Terse Offering list response", page.value);

  const first = page.value.items[0];
  if (first !== undefined) print("Full Offering response", await client.getOffering(first.id));
}

if (discovered === 0)
  throw new Error(
    "The mock directory found no reachable ODP Services. Start a Service or edit .env."
  );

function heading(value: string): void {
  process.stdout.write(`\n=== ${value} ===\n`);
}

function print(label: string, value: unknown): void {
  process.stdout.write(`\n${label}:\n${JSON.stringify(value, null, 2)}\n`);
}
