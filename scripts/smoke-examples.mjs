#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const root = new URL("..", import.meta.url);
const children = [];

try {
  const smallPort = await unusedPort();
  const smallUrl = `http://127.0.0.1:${smallPort}`;
  const small = start("small Service", "examples/odp-service-small/dist/index.js", smallPort);
  await waitFor(`${smallUrl}/.well-known/odp`, small);

  const marketplacePort = await unusedPort();
  const marketplaceUrl = `http://127.0.0.1:${marketplacePort}`;
  const marketplace = start(
    "marketplace Service",
    "examples/odp-service-marketplace/dist/index.js",
    marketplacePort
  );
  await waitFor(`${marketplaceUrl}/.well-known/odp`, marketplace);
  await smokeMarketplaceSearch(marketplaceUrl);
  const download = await fetch(`${smallUrl}/downloads/incident-plan.txt`);
  const downloadBody = await download.text();
  if (!download.ok || !downloadBody.includes("Incident Response Plan"))
    throw new Error(
      `Small Service download Action failed with HTTP ${download.status}: ${JSON.stringify(downloadBody)}`
    );
  const result = await run("examples/odp-agent-discovery/dist/index.js", {
    SERVICE_URLS: `${smallUrl},http://127.0.0.1:1,${marketplaceUrl}`
  });
  for (const expected of [
    "=== MOCK DIRECTORY ===",
    "Skipped unreachable Service:",
    "Small Example Store",
    "Marketplace Example",
    "ODP Service document:",
    "Terse Offering list response:",
    "Full Offering response:"
  ])
    if (!result.includes(expected))
      throw new Error(`Agent walkthrough omitted ${JSON.stringify(expected)}:\n${result}`);
  process.stdout.write("smoke-examples: small Service, marketplace Service, and agent OK\n");
} finally {
  for (const child of children) child.kill("SIGTERM");
}

async function smokeMarketplaceSearch(serviceUrl) {
  const first = await fetch(`${serviceUrl}/odp/offerings/search`, {
    method: "POST",
    headers: { "content-type": "application/odp+json" },
    body: JSON.stringify({ odp_version: "1.0", query: "gpu", limit: 2 })
  });
  if (!first.ok) throw new Error(`Marketplace search failed with HTTP ${first.status}`);
  const page = await first.json();
  if (!Array.isArray(page.items) || page.items.length !== 2 || typeof page.next !== "string")
    throw new Error("Marketplace search did not return a bounded continuation page");
  const second = await fetch(new URL(page.next, serviceUrl));
  if (!second.ok) throw new Error(`Marketplace continuation failed with HTTP ${second.status}`);
  const continuation = await second.json();
  if (!Array.isArray(continuation.items) || continuation.items[0]?.id !== "gpu-00000002")
    throw new Error("Marketplace stateless continuation did not preserve search state");
}

function start(name, script, port) {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.name = name;
  children.push(child);
  return child;
}

async function run(script, env) {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const code = await new Promise((resolve) => child.once("close", resolve));
  if (code !== 0) throw new Error(`Agent example failed:\n${stdout}\n${stderr}`);
  return stdout;
}

async function waitFor(url, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${child.name} exited before becoming ready`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(50);
  }
  throw new Error(`${child.name} did not become ready`);
}

function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close();
        reject(new Error("Could not allocate a port"));
        return;
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });
}
