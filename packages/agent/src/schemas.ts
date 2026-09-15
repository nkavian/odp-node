import { Buffer } from "node:buffer";

import $RefParser, { type FileInfo } from "@apidevtools/json-schema-ref-parser";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

import { resolveResourceReference } from "@offering-protocol/core";

import type { OdpCache } from "./cache.js";
import { requestSupportingJson, type OdpTransport } from "./transport.js";

const DIALECT = "https://json-schema.org/draft/2020-12/schema";
/** ERR-21: distinct documents in one schema graph. */
const MAXIMUM_DOCUMENTS = 16;
/** ERR-21: Attribute Schema reference depth. */
const MAXIMUM_DEPTH = 8;
/** ERR-21: complete Attribute Schema reference graph. */
const MAXIMUM_GRAPH_BYTES = 1_048_576;
/** ERR-21: one Attribute Schema document. */
const MAXIMUM_DOCUMENT_BYTES = 262_144;
const STANDARD_VOCABULARY = "https://json-schema.org/draft/2020-12/vocab/";
/**
 * SEC-06 requires documented time, memory, recursion and evaluation limits for schema processing.
 * These are ours: a wall-clock budget for resolving the whole reference graph, a cap on the length
 * of any single regular expression, and rejection of patterns whose shape admits catastrophic
 * backtracking. A schema that trips one of them is an unsupported Attribute Schema, which narrows
 * to uninterpretable `attributes` and leaves the rest of the Offering usable (OFR-44).
 */
const MAXIMUM_RESOLUTION_MS = 30_000;
const MAXIMUM_PATTERN_LENGTH = 1_000;

export type JsonSchema = Record<string, unknown>;

export interface SchemaResolutionOptions {
  url: URL;
  transport: OdpTransport;
  cache?: OdpCache;
  cachePartition?: string;
  signal?: AbortSignal;
}

export interface ResolvedSchema {
  schema: JsonSchema;
  validate(value: unknown): boolean;
}

export async function resolveSchema(options: SchemaResolutionOptions): Promise<ResolvedSchema> {
  // The graph budget is wall-clock as well as byte- and count-based: without it a graph of slow
  // documents stalls the caller indefinitely, since the bundler applies no timeout of its own.
  const deadline = AbortSignal.timeout(MAXIMUM_RESOLUTION_MS);
  const signal =
    options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]);
  const rootUrl = withoutFragment(String(options.url));
  const root = requireSchema(await retrieve(options.url));
  /** Depth of each known document *and of every `$id` scope it declares*, keyed without fragment. */
  const depths = new Map<string, number>();
  const fetched = new Set<string>([rootUrl]);
  let maximumKnownDepth = 0;
  let documents = 1;
  let graphBytes = encodedLength(root);
  /** The limit that stopped resolution, kept so the bundler's wrapper cannot hide the reason. */
  let refused: Error | undefined;
  registerScopes(root, rootUrl, 0);

  let bundled: unknown;
  try {
    bundled = await $RefParser.bundle(String(options.url), root, {
      parse: { binary: false, text: false, yaml: false },
      resolve: {
        file: false,
        http: false,
        odp: { order: 1, canRead: /^https?:\/\//u, read: readReference }
      },
      timeoutMs: MAXIMUM_RESOLUTION_MS
    });
  } catch (error) {
    throw refused ?? error;
  }
  const schema = requireSchema(bundled);
  requireSupportedVocabularies(schema);
  requireBoundedPatterns(schema);
  // `allErrors` off so validation short-circuits on the first failure instead of evaluating every
  // branch of an attacker-supplied schema.
  const ajv = new Ajv2020({ allErrors: false, strict: false, validateSchema: true });
  addFormatsModule.default(ajv);
  const validator = ajv.compile(schema);
  return { schema: structuredClone(schema), validate: (value) => validator(value) };

  async function readReference(file: FileInfo): Promise<Record<string, unknown>> {
    try {
      return await readBoundedReference(file);
    } catch (error) {
      // The bundler rewraps a resolver failure as a generic "Error reading file", which would
      // otherwise hide which ODP limit actually stopped the graph.
      refused ??= error instanceof Error ? error : undefined;
      throw error;
    }
  }

  async function readBoundedReference(file: FileInfo): Promise<Record<string, unknown>> {
    const url = resolveResourceReference(file.url, options.url.origin);
    const address = withoutFragment(String(url));
    // Sibling `$ref`s to one document are resolved concurrently, so the same URL can reach `read`
    // more than once. Count distinct documents, not reads (ERR-21).
    if (!fetched.has(address)) {
      documents += 1;
      if (documents > MAXIMUM_DOCUMENTS)
        throw new RangeError("ODP Attribute Schema graph exceeds 16 documents");
      fetched.add(address);
    }
    // `file.baseUrl` is the resolution base, which under the 2020-12 dynamic-id scope is the
    // nearest enclosing `$id` rather than the document URL — hence `registerScopes`. When it still
    // cannot be matched, assume the deepest level seen so far rather than the root, so an
    // unmatched base can never reset the depth accounting to zero and disable the limit.
    const parent = withoutFragment(file.baseUrl ?? String(options.url));
    const depth = (depths.get(parent) ?? maximumKnownDepth) + 1;
    if (depth > MAXIMUM_DEPTH)
      throw new RangeError("ODP Attribute Schema graph exceeds eight reference levels");
    // Keep the per-document cap under whatever remains of the graph budget so the total can never
    // overshoot by a whole document (ERR-21).
    const remaining = MAXIMUM_GRAPH_BYTES - graphBytes;
    if (remaining <= 0) throw new RangeError("ODP Attribute Schema graph exceeds its byte limit");
    const schema = requireSchema(await retrieve(url, Math.min(MAXIMUM_DOCUMENT_BYTES, remaining)));
    graphBytes += encodedLength(schema);
    if (graphBytes > MAXIMUM_GRAPH_BYTES)
      throw new RangeError("ODP Attribute Schema graph exceeds its byte limit");
    registerScopes(schema, address, depth);
    return schema;
  }

  /**
   * Records the depth of a document and of each `$id` scope inside it, so a later reference whose
   * resolution base is an inner `$id` still resolves to a known depth.
   */
  function registerScopes(document: JsonSchema, documentUrl: string, depth: number): void {
    maximumKnownDepth = Math.max(maximumKnownDepth, depth);
    depths.set(documentUrl, depth);
    const pending: unknown[] = [document];
    while (pending.length > 0) {
      const value = pending.pop();
      if (typeof value !== "object" || value === null) continue;
      if (Array.isArray(value)) {
        pending.push(...(value as unknown[]));
        continue;
      }
      const object = value as Record<string, unknown>;
      const id = object["$id"];
      if (typeof id === "string") {
        try {
          depths.set(withoutFragment(new URL(id, documentUrl).href), depth);
        } catch {
          // An `$id` that resolves to nothing contributes no scope we can key on.
        }
      }
      pending.push(...Object.values(object));
    }
  }

  function retrieve(url: URL, maximumBytes = MAXIMUM_DOCUMENT_BYTES): Promise<unknown> {
    return requestSupportingJson({
      transport: options.transport,
      url,
      ...(options.cache === undefined ? {} : { cache: options.cache }),
      // SEC-17: supporting resources are fetched anonymously, so they share one cache partition
      // regardless of the caller's authentication context.
      cachePartition: options.cachePartition ?? "anonymous",
      resourceClass: "attribute-schema",
      fallbackTtlMs: 86_400_000,
      accept: "application/schema+json",
      mediaTypes: ["application/schema+json"],
      maximumBytes,
      validate: requireSchema,
      signal
    });
  }
}

function requireSchema(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("ODP Attribute Schema must be a JSON object");
  const schema = value as Record<string, unknown>;
  if (schema["$schema"] !== DIALECT)
    throw new TypeError("ODP Attribute Schema must declare JSON Schema Draft 2020-12");
  requireFragmentDynamicReferences(schema);
  return schema;
}

function requireFragmentDynamicReferences(schema: JsonSchema): void {
  for (const object of objectsIn(schema)) {
    const reference = object["$dynamicRef"];
    if (reference !== undefined && (typeof reference !== "string" || !reference.startsWith("#")))
      throw new TypeError("ODP Attribute Schema $dynamicRef must be a fragment-only reference");
  }
}

function requireSupportedVocabularies(schema: JsonSchema): void {
  for (const object of objectsIn(schema)) {
    const vocabulary = object["$vocabulary"];
    if (typeof vocabulary === "object" && vocabulary !== null && !Array.isArray(vocabulary))
      for (const [uri, required] of Object.entries(vocabulary))
        if (required === true && !uri.startsWith(STANDARD_VOCABULARY))
          throw new TypeError(`ODP Attribute Schema requires unsupported vocabulary ${uri}`);
  }
}

/**
 * SEC-06: an Attribute Schema is untrusted input, and Ajv turns `pattern` / `patternProperties`
 * into native regular expressions with no backtracking guard. Reject over-long patterns and the
 * nested-unbounded-quantifier shape — `(a+)+`, `(a*)*`, `([0-9]+)*` — whose matching time is
 * exponential in the input length.
 */
function requireBoundedPatterns(schema: JsonSchema): void {
  for (const object of objectsIn(schema)) {
    const pattern = object["pattern"];
    if (typeof pattern === "string") requireBoundedPattern(pattern);
    const patternProperties = object["patternProperties"];
    if (
      typeof patternProperties === "object" &&
      patternProperties !== null &&
      !Array.isArray(patternProperties)
    )
      for (const key of Object.keys(patternProperties)) requireBoundedPattern(key);
  }
}

/** Every plain object reachable from `root`, including `root` itself. */
function* objectsIn(root: JsonSchema): Generator<Record<string, unknown>> {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null) continue;
    if (Array.isArray(value)) {
      pending.push(...(value as unknown[]));
      continue;
    }
    const object = value as Record<string, unknown>;
    yield object;
    pending.push(...Object.values(object));
  }
}

function requireBoundedPattern(pattern: string): void {
  if (pattern.length > MAXIMUM_PATTERN_LENGTH)
    throw new TypeError("ODP Attribute Schema regular expression exceeds its length limit");
  if (hasNestedQuantifier(pattern))
    throw new TypeError(
      "ODP Attribute Schema regular expression uses a nested unbounded quantifier"
    );
}

/**
 * A single atom — one character, one escape, or one character class — carrying an unbounded
 * quantifier. `(a+)+` is exponential because the group and its body can both consume the same
 * characters; `(-[a-z]+)*` is not, because the literal anchors each repetition, so only the
 * single-atom shape is rejected.
 */
const REPEATED_ATOM = /^(?:\\.|\[(?:\\.|[^\]])*\]|[^\\[\](){}|*+?^$])(?:\*|\+|\{\d+,\}?)$/u;

/** True when a quantified group's body is itself an unbounded repetition of one atom. */
function hasNestedQuantifier(pattern: string): boolean {
  const open: number[] = [];
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (inClass) {
      if (character === "]") inClass = false;
      continue;
    }
    if (character === "[") {
      inClass = true;
      continue;
    }
    if (character === "(") {
      open.push(index + 1);
      continue;
    }
    if (character !== ")") continue;
    const start = open.pop();
    if (start === undefined) continue;
    if (!isQuantifier(pattern, index + 1)) continue;
    if (isRepeatedAtom(pattern.slice(start, index))) return true;
  }
  return false;
}

function isRepeatedAtom(body: string): boolean {
  let inner = body.startsWith("?:") ? body.slice(2) : body;
  while (inner.startsWith("(") && inner.endsWith(")") && balanced(inner.slice(1, -1)))
    inner = inner.slice(1, -1).replace(/^\?:/u, "");
  return splitAlternatives(inner).some((branch) => REPEATED_ATOM.test(branch));
}

function balanced(value: string): boolean {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function splitAlternatives(body: string): string[] {
  const branches: string[] = [];
  let depth = 0;
  let start = 0;
  let inClass = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (inClass) {
      if (character === "]") inClass = false;
      continue;
    }
    if (character === "[") inClass = true;
    else if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "|" && depth === 0) {
      branches.push(body.slice(start, index));
      start = index + 1;
    }
  }
  branches.push(body.slice(start));
  return branches;
}

function isQuantifier(pattern: string, index: number): boolean {
  const character = pattern[index];
  return character === "*" || character === "+" || character === "{";
}

function encodedLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function withoutFragment(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return String(url);
}
