import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import schema0 from "./schemas/action-relation.schema.json" with { type: "json" };
import schema1 from "./schemas/action-request.schema.json" with { type: "json" };
import schema2 from "./schemas/action.schema.json" with { type: "json" };
import authenticationRequirementSchema from "./schemas/authentication-requirement.schema.json" with { type: "json" };
import schema3 from "./schemas/attribute-schema-reference.schema.json" with { type: "json" };
import schema4 from "./schemas/capability-identifier.schema.json" with { type: "json" };
import schema5 from "./schemas/capability-link.schema.json" with { type: "json" };
import schema6 from "./schemas/collection-search-request.schema.json" with { type: "json" };
import schema7 from "./schemas/collection.schema.json" with { type: "json" };
import schema8 from "./schemas/detail-fields.schema.json" with { type: "json" };
import enrollmentProtocolSchema from "./schemas/enrollment-protocol.schema.json" with { type: "json" };
import schema9 from "./schemas/filter-capability-source.schema.json" with { type: "json" };
import schema10 from "./schemas/filter-definition-page.schema.json" with { type: "json" };
import schema11 from "./schemas/filter-definition.schema.json" with { type: "json" };
import schema12 from "./schemas/filter-expression.schema.json" with { type: "json" };
import schema13 from "./schemas/filter-operator.schema.json" with { type: "json" };
import schema14 from "./schemas/filter-type.schema.json" with { type: "json" };
import schema15 from "./schemas/filter-unit.schema.json" with { type: "json" };
import schema16 from "./schemas/http-action-target.schema.json" with { type: "json" };
import schema17 from "./schemas/invalid-parameter.schema.json" with { type: "json" };
import schema18 from "./schemas/local-resource-identifier-list.schema.json" with { type: "json" };
import schema19 from "./schemas/local-resource-identifier.schema.json" with { type: "json" };
import schema20 from "./schemas/offering-search-request.schema.json" with { type: "json" };
import schema21 from "./schemas/offering-search-response.schema.json" with { type: "json" };
import schema22 from "./schemas/offering.schema.json" with { type: "json" };
import schema23 from "./schemas/openapi-action-target.schema.json" with { type: "json" };
import operationDescriptorSchema from "./schemas/operation-descriptor.schema.json" with { type: "json" };
import schema24 from "./schemas/page-envelope.schema.json" with { type: "json" };
import schema25 from "./schemas/page-limit.schema.json" with { type: "json" };
import schema26 from "./schemas/price-preview.schema.json" with { type: "json" };
import paymentProtocolSchema from "./schemas/payment-protocol.schema.json" with { type: "json" };
import schema27 from "./schemas/problem-code.schema.json" with { type: "json" };
import schema28 from "./schemas/problem-details.schema.json" with { type: "json" };
import schema29 from "./schemas/protocol-version.schema.json" with { type: "json" };
import schema30 from "./schemas/refinement-bucket.schema.json" with { type: "json" };
import schema31 from "./schemas/refinement-group.schema.json" with { type: "json" };
import schema32 from "./schemas/representation.schema.json" with { type: "json" };
import schema33 from "./schemas/resource-identity.schema.json" with { type: "json" };
import schema34 from "./schemas/resource-reference.schema.json" with { type: "json" };
import schema35 from "./schemas/schema-reference.schema.json" with { type: "json" };
import schema36 from "./schemas/search-capabilities.schema.json" with { type: "json" };
import serviceBrandingImageSchema from "./schemas/service-branding-image.schema.json" with { type: "json" };
import serviceBrandingSchema from "./schemas/service-branding.schema.json" with { type: "json" };
import schema37 from "./schemas/service-document.schema.json" with { type: "json" };
import serviceOpenApiSchema from "./schemas/service-openapi.schema.json" with { type: "json" };
import schema38 from "./schemas/service-origin.schema.json" with { type: "json" };
import schema39 from "./schemas/service-protocols.schema.json" with { type: "json" };
import schema40 from "./schemas/sort-capability-source.schema.json" with { type: "json" };
import schema41 from "./schemas/sort-definition-page.schema.json" with { type: "json" };
import schema42 from "./schemas/sort-definition.schema.json" with { type: "json" };
import schema43 from "./schemas/sort-key.schema.json" with { type: "json" };
import schema44 from "./schemas/top-level-document.schema.json" with { type: "json" };

export const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
  strictTypes: false
});
addFormatsModule.default(ajv);

const schemas = [
  schema0,
  schema1,
  schema2,
  authenticationRequirementSchema,
  schema3,
  schema4,
  schema5,
  schema6,
  schema7,
  schema8,
  enrollmentProtocolSchema,
  schema9,
  schema10,
  schema11,
  schema12,
  schema13,
  schema14,
  schema15,
  schema16,
  schema17,
  schema18,
  schema19,
  schema20,
  schema21,
  schema22,
  schema23,
  operationDescriptorSchema,
  schema24,
  schema25,
  schema26,
  paymentProtocolSchema,
  schema27,
  schema28,
  schema29,
  schema30,
  schema31,
  schema32,
  schema33,
  schema34,
  schema35,
  schema36,
  serviceBrandingImageSchema,
  serviceBrandingSchema,
  schema37,
  serviceOpenApiSchema,
  schema38,
  schema39,
  schema40,
  schema41,
  schema42,
  schema43,
  schema44
];
for (const schema of schemas) ajv.addSchema(schema);
