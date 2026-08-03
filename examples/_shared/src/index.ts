import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadEnvFile } from "node:process";

import type { OdpService } from "@offering-protocol/service";
import type { RequestHandler } from "express";

interface NodeRequestInit extends RequestInit {
  duplex: "half";
}

export type ExampleRoute = (
  request: Request
) => Response | undefined | Promise<Response | undefined>;

export function serveOdp(service: OdpService, label: string, route?: ExampleRoute): void {
  loadExampleEnvironment();
  const host = process.env["HOST"] ?? "127.0.0.1";
  const configuredPort = process.env["PORT"];
  if (configuredPort === undefined)
    throw new Error("PORT is required. Copy this example's .env.example to .env.");
  const port = parsePort(configuredPort);
  const server = createServer((request, response) => {
    void handle(service, host, port, request, response, route);
  });
  server.listen(port, host, () => {
    const origin = `http://${host}:${port}`;
    process.stdout.write(
      [
        `${label} is ready`,
        `  Service document: ${origin}/.well-known/odp`,
        `  ODP endpoint base: ${origin}${service.document.http.endpoint_base}`,
        ""
      ].join("\n")
    );
  });
}

export function createExpressOdpHandler(service: OdpService, origin: string): RequestHandler {
  return (request, response, next) => {
    const path = request.path;
    if (path !== "/.well-known/odp" && !path.startsWith("/odp/")) {
      next();
      return;
    }
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : JSON.stringify(request.body);
    void service
      .fetch(
        new Request(`${origin}${request.originalUrl}`, {
          method: request.method,
          headers: requestHeaders(request),
          ...(body === undefined ? {} : { body })
        })
      )
      .then(async (result) => {
        response.status(result.status);
        result.headers.forEach((value, name) => response.setHeader(name, value));
        response.send(Buffer.from(await result.arrayBuffer()));
      })
      .catch(next);
  };
}

export function loadExampleEnvironment(): void {
  try {
    loadEnvFile();
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new RangeError("PORT must be an integer from 1 through 65535");
  return port;
}

async function handle(
  service: OdpService,
  host: string,
  port: number,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  route?: ExampleRoute
): Promise<void> {
  try {
    const method = incoming.method ?? "GET";
    const body = method === "GET" || method === "HEAD" ? undefined : await readBody(incoming);
    const init: NodeRequestInit = {
      method,
      headers: requestHeaders(incoming),
      duplex: "half",
      ...(body === undefined ? {} : { body })
    };
    const request = new Request(
      `http://${incoming.headers.host ?? `${host}:${port}`}${incoming.url ?? "/"}`,
      init
    );
    const response = (await route?.(request.clone())) ?? (await service.fetch(request));
    process.stdout.write(
      `${request.method} ${new URL(request.url).pathname} -> ${response.status}\n`
    );
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(500, { "content-type": "text/plain" });
    outgoing.end("Example server failed");
  }
}

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  return await new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    request.on("data", (chunk: unknown) => {
      if (typeof chunk === "string" || chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
      else reject(new TypeError("Request body contained an unsupported chunk"));
    });
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("error", reject);
  });
}

function requestHeaders(request: Pick<IncomingMessage, "headers">): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}
