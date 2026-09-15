import { describe, expect, it } from "vitest";

import type {
  AuthenticationRequirement,
  HttpActionTarget,
  OfferingAction,
  OpenApiActionTarget
} from "@offering-protocol/core";

import { normalizeActions } from "../../src/offerings.js";

const ORIGIN = "https://example.com";

interface ActionOverrides {
  authentication?: AuthenticationRequirement;
  id?: string;
  rel?: string;
  description?: string;
}

/** An Action with a compact HTTP target. Written out rather than spread so the union stays exact. */
function action(overrides: ActionOverrides & { http?: HttpActionTarget } = {}): OfferingAction {
  return {
    authentication: overrides.authentication ?? "not-required",
    id: overrides.id ?? "buy",
    rel: overrides.rel ?? "purchase",
    ...(overrides.description === undefined ? {} : { description: overrides.description }),
    http: overrides.http ?? { href: "/buy", method: "POST" }
  };
}

/** An Action with an OpenAPI target. */
function openApiAction(
  overrides: ActionOverrides & { openapi?: OpenApiActionTarget } = {}
): OfferingAction {
  return {
    authentication: overrides.authentication ?? "not-required",
    id: overrides.id ?? "buy",
    rel: overrides.rel ?? "purchase",
    ...(overrides.description === undefined ? {} : { description: overrides.description }),
    openapi: overrides.openapi ?? { operation_id: "buy" }
  };
}

describe("Action normalization", () => {
  it("returns nothing at all for an Offering with no actions", () => {
    expect(normalizeActions(undefined, ORIGIN)).toEqual({ issues: [] });
  });

  it("resolves a compact HTTP target against the Service Origin", () => {
    const result = normalizeActions([action()], ORIGIN);
    expect(result.actions?.[0]?.target).toEqual({
      kind: "http",
      url: "https://example.com/buy",
      method: "POST"
    });
    expect(result.issues).toEqual([]);
  });

  it("carries the optional members of a compact target through", () => {
    const result = normalizeActions(
      [
        action({
          description: "Buy it",
          http: {
            href: "/buy",
            method: "GET",
            request: { content_type: "application/json" },
            response_content_types: ["application/json"]
          }
        })
      ],
      ORIGIN
    );
    const first = result.actions?.[0];
    expect(first?.description).toBe("Buy it");
    expect(first?.target).toMatchObject({
      request: { content_type: "application/json" },
      response_content_types: ["application/json"]
    });
  });

  it("inherits the Service-wide OpenAPI document and lets an Action override it", () => {
    const inherited = normalizeActions([openApiAction()], ORIGIN, "/openapi.json");
    expect(inherited.actions?.[0]?.target).toEqual({
      kind: "openapi",
      url: "https://example.com/openapi.json",
      operation_id: "buy"
    });

    const overridden = normalizeActions(
      [openApiAction({ openapi: { operation_id: "buy", url: "https://cdn.example/api.json" } })],
      ORIGIN,
      "/openapi.json"
    );
    expect(overridden.actions?.[0]?.target).toMatchObject({ url: "https://cdn.example/api.json" });
  });

  it("reports an OpenAPI Action with no document reference as unusable", () => {
    const result = normalizeActions([openApiAction()], ORIGIN);
    expect(result.actions).toBeUndefined();
    expect(result.issues[0]?.message).toContain("no OpenAPI document URL");
  });

  it("makes every Action bearing a duplicated identifier unusable", () => {
    const result = normalizeActions(
      [action(), action({ rel: "quote" }), action({ id: "other" })],
      ORIGIN
    );
    // Neither copy wins: an ambiguous identifier cannot be selected.
    expect(result.actions?.map(({ id }) => id)).toEqual(["other"]);
    expect(result.issues).toEqual([
      { scope: "action", action_id: "buy", message: "Duplicate Action identifier buy" }
    ]);
  });

  it("discards the whole Action list when it exceeds sixteen entries", () => {
    const actions = Array.from({ length: 17 }, (_value, index) =>
      action({ id: `a${String(index)}` })
    );
    const result = normalizeActions(actions, ORIGIN);
    expect(result.actions).toBeUndefined();
    expect(result.issues[0]?.message).toContain("more than the limit of 16");
  });

  it("keeps a list of exactly sixteen entries", () => {
    const actions = Array.from({ length: 16 }, (_value, index) =>
      action({ id: `a${String(index)}` })
    );
    expect(normalizeActions(actions, ORIGIN).actions).toHaveLength(16);
  });

  it("narrows an invalid relation token to the Action that carries it", () => {
    const result = normalizeActions(
      [action({ id: "bad", rel: "Not A Token" }), action({ id: "good" })],
      ORIGIN
    );
    expect(result.actions?.map(({ id }) => id)).toEqual(["good"]);
    expect(result.issues[0]).toMatchObject({ action_id: "bad" });
  });

  it("narrows an over-long relation token to the Action that carries it", () => {
    const result = normalizeActions([action({ rel: "a".repeat(65) })], ORIGIN);
    expect(result.actions).toBeUndefined();
    expect(result.issues[0]?.message).toContain("not a valid ODP relation token");
  });

  it("accepts an unknown but well-formed relation", () => {
    const result = normalizeActions([action({ rel: "lease-renew" })], ORIGIN);
    expect(result.actions?.[0]?.rel).toBe("lease-renew");
    expect(result.issues).toEqual([]);
  });

  it("narrows an unusable target reference to its own Action", () => {
    const result = normalizeActions(
      [action({ id: "bad", http: { href: "../escape", method: "GET" } }), action({ id: "good" })],
      ORIGIN
    );
    expect(result.actions?.map(({ id }) => id)).toEqual(["good"]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.action_id).toBe("bad");
  });
});
