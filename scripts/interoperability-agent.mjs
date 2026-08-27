#!/usr/bin/env node

import { createOdpServiceClient } from "../packages/agent/dist/index.js";

const serviceUrl = process.argv[2];
if (serviceUrl === undefined) throw new Error("usage: interoperability-agent.mjs SERVICE_URL");

const client = createOdpServiceClient({ serviceUrl, allowLocalNetwork: true });
const inspection = await client.inspect();
if (inspection.document.name.length === 0) throw new Error("Service name is empty");
for (const operation of ["get-offering", "list-offerings"])
  if (!inspection.capabilities.operations.some(({ name }) => name === operation))
    throw new Error(`Service omitted required operation ${operation}`);

const result = await client.listOfferings({ limit: 50 }).pages[Symbol.asyncIterator]().next();
const first = result.done ? undefined : result.value.items[0];
if (first === undefined) throw new Error("Service returned no Offerings");
const details = await client.getOffering(first.id);
if (details.id !== first.id || details.name !== first.name)
  throw new Error("Full Offering does not match its listed summary");
const action = details.actions?.[0];
if (action !== undefined) {
  const resolved = await client.resolveAction(details.id, action.id);
  if (resolved.action.id !== action.id) throw new Error("Resolved Action identifier changed");
}

process.stdout.write(`Node.js Agent interoperates with ${inspection.document.name}\n`);
