import { describe, expect, it } from "vitest";

import {
  isLocalResourceIdentifier,
  parseProblemResponse,
  resourceIdentitiesEqual,
  safeParsePage,
  safeParseProblemDetails,
  safeParseServiceDocument,
  type ResourceIdentity
} from "../../src/index.js";
import errorsLimits from "../vectors/errors-limits-contract.json" with { type: "json" };
import identityComparison from "../vectors/identity-identity-comparison.json" with { type: "json" };
import localIdentifier from "../vectors/identity-local-identifier.json" with { type: "json" };
import pagination from "../vectors/pagination-contract.json" with { type: "json" };
import serviceDocument from "../vectors/service-document-validation.json" with { type: "json" };

describe("odp-specs conformance vectors", () => {
  for (const testCase of localIdentifier.cases) {
    it(`local identifier: ${testCase.name}`, () => {
      expect(isLocalResourceIdentifier(testCase.value)).toBe(testCase.valid);
    });
  }

  for (const testCase of identityComparison.cases) {
    it(`resource identity: ${testCase.name}`, () => {
      expect(
        resourceIdentitiesEqual(
          testCase.left as ResourceIdentity,
          testCase.right as ResourceIdentity
        )
      ).toBe(testCase.same_identity);
    });
  }

  for (const testCase of serviceDocument.cases) {
    it(`Service Document: ${testCase.name}`, () => {
      expect(safeParseServiceDocument(testCase.document).success).toBe(testCase.valid);
    });
  }

  for (const testCase of pagination.cases.filter(
    (candidate) => candidate.operation === "validate-page"
  )) {
    it(`page envelope: ${testCase.name}`, () => {
      expect(safeParsePage(testCase.page).success).toBe(testCase.valid);
    });
  }

  for (const testCase of errorsLimits.cases.filter(
    (candidate) => candidate.operation === "validate-problem"
  )) {
    it(`Problem Details: ${testCase.name}`, () => {
      const httpStatus = testCase.http_status;
      if (httpStatus === undefined) throw new Error("Problem vector is missing http_status");
      const schemaValid = safeParseProblemDetails(testCase.problem).success;
      const statusValid = (() => {
        try {
          parseProblemResponse(testCase.problem, httpStatus);
          return true;
        } catch {
          return false;
        }
      })();
      expect(schemaValid && statusValid).toBe(testCase.valid);
    });
  }
});
