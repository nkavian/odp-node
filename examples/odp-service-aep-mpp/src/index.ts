import { randomUUID } from "node:crypto";

import { AEP_GRANT_TYPE_API_KEY } from "@aep-foundation/core";
import type { ApiKeyGrantResponse } from "@aep-foundation/core";
import {
  createExpressAepProtectedResourceHandler,
  registerExpressAepRoutes
} from "@aep-foundation/express";
import {
  createAepService,
  createDidWebClientAssertionVerifier,
  createInMemoryClientAssertionReplayStore,
  createInMemoryCommandIdempotencyStore,
  createInMemoryEnrollmentStore,
  createInMemoryServiceCredentialStore,
  createStaticEnrollmentPolicy,
  didWebIdentityMethod,
  storedApiKeyGrantType
} from "@aep-foundation/service";
import { inflow } from "@inflowpayai/mpp-seller";
import {
  createExpressOdpHandler,
  loadExampleEnvironment
} from "@offering-protocol/examples-shared";
import { createOdpService, createStaticCatalog } from "@offering-protocol/service";
import express from "express";
import { Mppx } from "mppx/express";

loadExampleEnvironment();

const host = requiredEnvironment("HOST");
const port = Number(requiredEnvironment("PORT"));
const origin = `http://${host}:${port.toString()}`;
const apiKey = requiredEnvironment("INFLOW_API_KEY");
const baseUrl = requiredEnvironment("INFLOW_BASE_URL");
const secretKey = requiredEnvironment("MPP_SECRET_KEY");
const serviceDid = requiredEnvironment("SERVICE_DID");

const odp = createOdpService({
  document: {
    description: "Reports available to enrolled agents through MPP.",
    http: { endpoint_base: "/odp" },
    keywords: ["reports", "research"],
    language: "en",
    localizations: ["en"],
    name: "AEP and MPP Report Service",
    protocols: { onboarding: ["aep"], payments: ["mpp"] }
  },
  catalog: createStaticCatalog({
    offerings: [
      {
        actions: [
          {
            http: {
              href: "/actions/report",
              method: "GET",
              response_content_types: ["application/json"]
            },
            id: "purchase-report",
            rel: "purchase"
          }
        ],
        description: "A machine-readable operational risk report.",
        id: "report",
        name: "Operational Risk Report",
        odp_version: "1.0",
        price: { amount: "0.01", currency: "USDC", type: "fixed" }
      }
    ]
  })
});

const credentials = createInMemoryServiceCredentialStore();
const aep = createAepService({
  authenticationMethods: [AEP_GRANT_TYPE_API_KEY],
  clientAssertionVerifier: createDidWebClientAssertionVerifier(),
  commandIdempotencyStore: createInMemoryCommandIdempotencyStore(),
  enrollmentPolicy: createStaticEnrollmentPolicy(),
  enrollmentStore: createInMemoryEnrollmentStore(),
  grantTypes: [
    storedApiKeyGrantType({
      issue: (): ApiKeyGrantResponse => ({
        api_key: randomUUID(),
        credential_id: randomUUID(),
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        header: "x-aep-api-key",
        scopes: ["purchase:reports"]
      }),
      store: credentials
    })
  ],
  identityMethods: [didWebIdentityMethod()],
  openapi: { pathMatching: { trailingSlash: "strict" }, url: "/openapi.json" },
  replayStore: createInMemoryClientAssertionReplayStore(),
  serviceDid
});
const mpp = Mppx.create({
  methods: [inflow({ apiKey, baseUrl })],
  secretKey
});
const app = express();

app.use(express.json({ type: ["application/aep+json", "application/json"] }));
app.use((request, response, next) => {
  response.on("finish", () =>
    process.stdout.write(`${request.method} ${request.path} -> ${response.statusCode.toString()}\n`)
  );
  next();
});
registerExpressAepRoutes(app, aep);
app.get("/openapi.json", (_request, response) => response.json(openApiDocument()));
app.use(createExpressOdpHandler(odp, origin));
app.get(
  "/actions/report",
  createExpressAepProtectedResourceHandler(aep, origin),
  mpp.charge({ amount: "0.01", currency: "USDC" }),
  (_request, response) => response.json({ report: "Operational risk is within tolerance." })
);
app.listen(port, host, () => {
  process.stdout.write(
    `AEP and MPP ODP Service is ready\n  Service document: ${origin}/.well-known/odp\n  Offering: ${origin}/odp/offerings/report\n  Protected Action: ${origin}/actions/report\n`
  );
});

function openApiDocument(): Record<string, unknown> {
  return {
    components: {
      securitySchemes: {
        aepApiKey: {
          in: "header",
          name: "x-aep-api-key",
          type: "apiKey",
          "x-aep-authentication-method": AEP_GRANT_TYPE_API_KEY
        }
      }
    },
    info: { title: "AEP and MPP protected ODP Action", version: "1.0.0" },
    openapi: "3.1.0",
    paths: {
      "/actions/report": {
        get: {
          operationId: "purchaseReport",
          responses: { "200": { description: "Purchased report" } },
          security: [{ aepApiKey: [] }]
        }
      }
    }
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}
