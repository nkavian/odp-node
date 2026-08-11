import {
  createInflowFacilitator,
  createInflowSellerClient,
  inflowAccepts,
  inflowSchemeRegistrations
} from "@inflowpayai/x402-seller";
import {
  createExpressOdpHandler,
  loadExampleEnvironment
} from "@offering-protocol/examples-shared";
import { createOdpService, createStaticCatalog } from "@offering-protocol/service";
import { paymentMiddlewareFromConfig } from "@x402/express";
import express from "express";

loadExampleEnvironment();

const host = requiredEnvironment("HOST");
const port = Number(requiredEnvironment("PORT"));
const origin = `http://${host}:${port.toString()}`;
const apiKey = requiredEnvironment("INFLOW_API_KEY");
const facilitator = createInflowFacilitator({ apiKey, environment: "sandbox" });
const seller = await createInflowSellerClient({ apiKey, environment: "sandbox" });
const odp = createOdpService({
  document: {
    description: "Datasets available through x402.",
    http: { endpoint_base: "/odp" },
    keywords: ["data", "risk"],
    language: "en",
    localizations: ["en"],
    name: "x402 Dataset Service",
    protocols: {
      payments: [{ authentication: "not-required", name: "x402", options: ["inflow"] }]
    }
  },
  catalog: createStaticCatalog({
    offerings: [
      {
        actions: [
          {
            authentication: "not-required",
            http: {
              href: "/actions/dataset",
              method: "GET",
              response_content_types: ["application/json"]
            },
            id: "download-dataset",
            rel: "download"
          }
        ],
        description: "A machine-readable operational risk dataset.",
        id: "dataset",
        name: "Operational Risk Dataset",
        odp_version: "1.0",
        price: { amount: "0.01", currency: "USD", type: "fixed" }
      }
    ]
  })
});
const app = express();

app.use(express.json());
app.use((request, response, next) => {
  response.on("finish", () =>
    process.stdout.write(`${request.method} ${request.path} -> ${response.statusCode.toString()}\n`)
  );
  next();
});
app.use(createExpressOdpHandler(odp, origin));
app.use(
  paymentMiddlewareFromConfig(
    {
      "GET /actions/dataset": {
        accepts: await inflowAccepts(seller, { price: "$0.01", schemes: ["exact"] })
      }
    },
    [facilitator],
    await inflowSchemeRegistrations(seller)
  )
);
app.get("/actions/dataset", (_request, response) =>
  response.json({ records: [{ category: "operational", score: 0.12 }] })
);
app.listen(port, host, () => {
  process.stdout.write(
    `x402 ODP Service is ready\n  Service document: ${origin}/.well-known/odp\n  Offering: ${origin}/odp/offerings/dataset\n  Protected Action: ${origin}/actions/dataset\n`
  );
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}
