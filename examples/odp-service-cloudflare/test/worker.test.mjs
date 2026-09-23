import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import { Miniflare, Response as RuntimeResponse } from "miniflare";

const root = path.resolve(import.meta.dirname, "..");
const configuration = JSON.parse(await readFile(path.join(root, "wrangler.json"), "utf8"));
let worker;

async function runtime(file, dev) {
  return new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "odp-test",
          compatibilityDate: configuration.compatibility_date,
          compatibilityFlags: configuration.compatibility_flags,
          manifest: {
            mainModule: "worker.mjs",
            modulesRoot: "/",
            modules: {
              "worker.mjs": { type: "esm", contents: await readFile(path.join(root, file), "utf8") }
            }
          }
        },
        ...(dev === undefined ? {} : { dev })
      }
    ]
  });
}

before(async () => {
  worker = await runtime("dist/index.js");
});

after(async () => {
  await worker?.dispose();
});

test("serves a Service Document without runtime code generation", async () => {
  const response = await worker.dispatchFetch("http://localhost/.well-known/odp");
  assert.equal(response.status, 200);
  const document = await response.json();
  assert.equal(document.odp_version, "1.0");
  assert.equal(document.http.endpoint_base, "/odp");
  assert.deepEqual(document.operations.map(({ name }) => name).sort(), [
    "get-offering",
    "list-offerings"
  ]);
});

test("serves terse and full Offerings and the download Action", async () => {
  for (const representation of ["terse", "full"]) {
    const list = await worker.dispatchFetch(
      `http://localhost/odp/offerings?representation=${representation}`
    );
    assert.equal(list.status, 200);
    const page = await list.json();
    assert.equal(page.odp_version, "1.0");
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].id, "incident-plan");
    assert.equal("actions" in page.items[0], representation === "full");
    const detail = await worker.dispatchFetch(
      `http://localhost/odp/offerings/incident-plan?representation=${representation}`
    );
    assert.equal(detail.status, 200);
    const offering = await detail.json();
    assert.equal(offering.name, "Incident Response Plan");
    assert.equal("actions" in offering, representation === "full");
    if (representation === "full") {
      const download = await worker.dispatchFetch(
        new URL(offering.actions[0].http.href, "http://localhost")
      );
      assert.equal(download.status, 200);
      assert.equal(await download.text(), "Incident Response Plan\n");
    }
  }
});

test("supports conditional GET and HEAD requests", async () => {
  const url = "http://localhost/odp/offerings/incident-plan";
  const first = await worker.dispatchFetch(url);
  const etag = first.headers.get("etag");
  assert.ok(etag);
  await first.arrayBuffer();
  const cached = await worker.dispatchFetch(url, { headers: { "if-none-match": etag } });
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), "");
  const head = await worker.dispatchFetch(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("etag"), etag);
  assert.equal(await head.text(), "");
});

test("returns structured errors for invalid requests and missing Offerings", async () => {
  for (const [suffix, status, code] of [
    ["offerings?limit=0", 400, "INVALID_REQUEST"],
    ["offerings?representation=unknown", 400, "INVALID_REQUEST"],
    ["offerings/missing", 404, "NOT_FOUND"]
  ]) {
    const response = await worker.dispatchFetch(`http://localhost/odp/${suffix}`);
    assert.equal(response.status, status);
    assert.match(response.headers.get("content-type"), /application\/problem\+json/);
    const problem = await response.json();
    assert.equal(problem.code, code);
    assert.equal(problem.status, status);
  }
});

test("uses the Workers fetch API for Directory requests", async () => {
  const require = createRequire(import.meta.url);
  const wrangler = path.join(
    path.dirname(require.resolve("wrangler/package.json")),
    "bin/wrangler.js"
  );
  await promisify(execFile)(
    process.execPath,
    [
      wrangler,
      "deploy",
      "test/directory-worker.mjs",
      "--dry-run",
      "--outdir",
      ".generated/directory"
    ],
    {
      cwd: root,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" }
    }
  );
  const requests = [];
  const service = {
    service_origin: "https://example.com",
    name: "Templates",
    description: "Downloadable templates.",
    language: "en",
    localizations: ["en"],
    operations: [
      { name: "list-offerings", authentication: "not-required" },
      { name: "get-offering", authentication: "not-required" }
    ],
    indexed_at: "2026-09-23T00:00:00Z"
  };
  const directory = await runtime(".generated/directory/directory-worker.js", {
    outboundService: {
      type: "fetcher",
      async handler(request) {
        requests.push({ url: request.url, method: request.method, body: await request.json() });
        return RuntimeResponse.json({ items: [service], count: 1 });
      }
    }
  });
  try {
    const response = await directory.dispatchFetch("http://localhost/");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{ items: [service], count: 1 }]);
    assert.deepEqual(requests, [
      {
        url: "https://api.inflowpay.ai/v1/services/search",
        method: "POST",
        body: { query: "templates" }
      }
    ]);
  } finally {
    await directory.dispose();
  }
});
