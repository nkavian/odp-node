#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const options = parseArguments(process.argv.slice(2));
const specs = resolve(options.specsDir);
const output = resolve(options.outputDir);
const adapter = resolve("scripts/conformance-adapter.mjs");
const runner = resolve(specs, "ietf/scripts/run_conformance.rb");
const implementation = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
mkdirSync(output, { recursive: true });

for (const role of ["agent", "service"]) {
  const result = spawnSync(
    "ruby",
    [
      runner,
      "--role",
      role,
      "--implementation-name",
      "odp-node",
      "--implementation-version",
      implementation.version,
      "--output",
      resolve(output, `${role}.json`),
      "--",
      process.execPath,
      adapter
    ],
    { cwd: specs, encoding: "utf8" }
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function parseArguments(args) {
  let specsDir = "../odp-specs";
  let outputDir = ".conformance/reports";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--specs-dir" || argument === "--output-dir") {
      if (value === undefined) throw new Error(`${argument} requires a value`);
      if (argument === "--specs-dir") specsDir = value;
      else outputDir = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument ${argument}`);
    }
  }
  return { outputDir, specsDir };
}
