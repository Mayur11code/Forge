// src/lib/workflow/execution/trigger-context.ts
//
// Assignment 37.12 — THE RUNTIME-INPUT TRUST BOUNDARY.
//
// `startWorkflow` primes `WorkflowRun.context` with `{ trigger: { outputs } }`,
// which step inputs may read as `{{trigger.outputs.*}}` (resolver.ts:51,63;
// state.ts:62-67). Before this module, the only caller-supplied path into that
// namespace was `triggerWorkflowRun`'s free-form `triggerPayload`, typed as an
// unconstrained `Record<string, JsonValue>`. That is the wrong shape for a
// generated workflow:
//
//   * A validator-clean `WorkflowProposal` may NOT reference `trigger.outputs.*`
//     at all. `STATIC_TRIGGER_OUTPUT_FIELDS` is empty on purpose
//     (workflow-proposal-references.ts:119-132), so every `{{trigger.outputs.*}}`
//     reference is rejected at proposal time. A generated, materialized workflow
//     therefore consumes NO trigger data: its config is literal values only.
//   * The canvas's previous `mockProjectPayload` fabricated a `projectId` that
//     had nothing to do with the workflow being run — invented runtime data, not
//     a legitimate input.
//
// So the honest contract is narrow:
//
//   1. The trigger context is OPTIONAL and, for generated workflows, empty.
//   2. When a caller does supply one (a manually authored workflow that reads
//      `{{trigger.outputs.*}}`), it must be a bounded, JSON-safe object.
//   3. It can never carry tenant/identity authority — `orgId` is server-derived
//      and smuggled identity keys are refused rather than silently ignored, so
//      the boundary is explicit instead of relying on the resolver to ignore
//      them.
//
// This module is pure and dependency-free apart from the shared `JsonValue`
// type, so it can be unit-tested in isolation and reused by both the server
// action and (if ever needed) the documented test route.

import type { JsonValue } from "@/lib/workflow-types/type";

/**
 * Keys that carry tenant, identity or authorization meaning elsewhere in the
 * system. They are refused in a trigger context rather than accepted-and-ignored:
 * a payload that names `orgId` is either a mistake or an attempt to smuggle
 * authority, and the boundary should say so instead of quietly discarding it.
 *
 * This mirrors the spirit of `RESERVED_REFERENCE_SOURCES`
 * (workflow-proposal-references.ts:78-116) at the input boundary: the trigger
 * namespace exposes workflow data, never process/tenant/identity state.
 */
export const FORBIDDEN_TRIGGER_CONTEXT_KEYS: readonly string[] = [
  "orgId",
  "organizationId",
  "organization",
  "tenantId",
  "tenant",
  "userId",
  "user",
  "session",
  "auth",
  "workflowId",
  "runId",
  "stepId",
  "role",
  "roles",
  "isAdmin",
  "__proto__",
  "prototype",
  "constructor",
];

/** Maximum nesting depth of a trigger context (mirrors the resolver's bounded walk). */
export const MAX_TRIGGER_CONTEXT_DEPTH = 8;

/** Maximum number of values (objects/arrays/entries) a trigger context may contain. */
export const MAX_TRIGGER_CONTEXT_NODES = 256;

export type TriggerContextValidationResult =
  | { ok: true; value: Record<string, JsonValue> }
  | { ok: false; reason: string };

/**
 * Validate a caller-supplied trigger context.
 *
 * Returns a fresh, structurally-checked object on success. Rejects:
 *   * non-plain-object roots (arrays, primitives, class instances, null),
 *   * forbidden keys (tenant/identity/authority, prototype traversal),
 *   * non-JSON values (functions, symbols, Dates, undefined, NaN/Infinity),
 *   * trees deeper than `MAX_TRIGGER_CONTEXT_DEPTH` or larger than
 *     `MAX_TRIGGER_CONTEXT_NODES`.
 *
 * The `reason` is authored for a server log, not for the client; the caller
 * projects it to a public message separately (S5).
 */
export function validateTriggerContext(
  input: unknown,
): TriggerContextValidationResult {
  if (input === undefined || input === null) {
    return { ok: true, value: {} };
  }

  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "Trigger context must be a plain object." };
  }

  if (Object.getPrototypeOf(input) !== Object.prototype) {
    return { ok: false, reason: "Trigger context must be a plain object." };
  }

  const seen = new WeakSet<object>();
  let nodeCount = 0;

  const walk = (value: unknown, depth: number, path: string): JsonValue | symbol => {
    if (depth > MAX_TRIGGER_CONTEXT_DEPTH) {
      return FAIL_DEPTH;
    }

    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      nodeCount += 1;
      return value as JsonValue;
    }

    if (typeof value === "number") {
      if (!Number.isFinite(value)) return FAIL_NUMBER;
      nodeCount += 1;
      return value;
    }

    if (Array.isArray(value)) {
      if (seen.has(value)) return FAIL_CYCLE;
      seen.add(value);
      const out: JsonValue[] = [];
      for (const item of value) {
        const walked = walk(item, depth + 1, path);
        if (typeof walked === "symbol") return walked;
        out.push(walked);
      }
      nodeCount += 1;
      return out;
    }

    if (typeof value === "object") {
      if (Object.getPrototypeOf(value) !== Object.prototype) return FAIL_PLAIN;
      if (seen.has(value)) return FAIL_CYCLE;
      seen.add(value);
      const out: Record<string, JsonValue> = {};
      for (const [key, nested] of Object.entries(value)) {
        if (FORBIDDEN_TRIGGER_CONTEXT_KEYS.includes(key)) {
          return FORBIDDEN_KEY;
        }
        const walked = walk(nested, depth + 1, `${path}.${key}`);
        if (typeof walked === "symbol") return walked;
        out[key] = walked;
      }
      nodeCount += 1;
      return out;
    }

    nodeCount += 1;
    return FAIL_TYPE;
  };

  const result = walk(input, 0, "trigger");
  if (typeof result === "symbol") {
    return { ok: false, reason: describeFailure(result) };
  }

  if (nodeCount > MAX_TRIGGER_CONTEXT_NODES) {
    return {
      ok: false,
      reason: `Trigger context exceeds the maximum of ${MAX_TRIGGER_CONTEXT_NODES} values.`,
    };
  }

  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return { ok: false, reason: "Trigger context must be a plain object." };
  }

  return { ok: true, value: result as Record<string, JsonValue> };
}

// Distinct sentinels so the failure path can name the exact structural problem
// without threading an error object through the recursive walk.
const FAIL_DEPTH = Symbol("depth");
const FAIL_NUMBER = Symbol("number");
const FAIL_CYCLE = Symbol("cycle");
const FAIL_PLAIN = Symbol("plain");
const FAIL_TYPE = Symbol("type");
const FORBIDDEN_KEY = Symbol("forbidden");

function describeFailure(sentinel: symbol): string {
  switch (sentinel) {
    case FAIL_DEPTH:
      return `Trigger context exceeds the maximum nesting depth of ${MAX_TRIGGER_CONTEXT_DEPTH}.`;
    case FAIL_NUMBER:
      return "Trigger context contains a non-finite number, which JSON cannot store.";
    case FAIL_CYCLE:
      return "Trigger context contains a cyclic reference.";
    case FAIL_PLAIN:
      return "Trigger context must contain only plain objects.";
    case FORBIDDEN_KEY:
      return "Trigger context contains a reserved key.";
    case FAIL_TYPE:
      return "Trigger context contains a value that is not JSON-serialisable.";
    default:
      return "Trigger context is invalid.";
  }
}
