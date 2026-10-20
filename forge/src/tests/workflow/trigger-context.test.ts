// src/tests/workflow/trigger-context.test.ts
//
// Assignment 37.12 — unit coverage for the runtime-input trust boundary.
//
// `validateTriggerContext` is the sole gateway for a caller-supplied trigger
// context becoming `WorkflowRun.context.trigger.outputs`. These tests pin the
// properties the boundary must keep:
//
//   * absent / null / empty are valid and normalise to `{}` (a generated
//     workflow supplies nothing);
//   * ordinary JSON trees pass through, and the returned value is a fresh copy;
//   * tenant/identity/prototype keys are REFUSED (not silently dropped);
//   * non-JSON values, non-plain objects, cycles, over-deep and over-large
//     trees are refused.
//
// Pure function: no DB, no server-only, no mocks.

import {
  validateTriggerContext,
  FORBIDDEN_TRIGGER_CONTEXT_KEYS,
  MAX_TRIGGER_CONTEXT_DEPTH,
} from "@/lib/workflow/execution/trigger-context";

describe("validateTriggerContext", () => {
  it("treats absent, null and empty input as an empty context", () => {
    expect(validateTriggerContext(undefined)).toEqual({ ok: true, value: {} });
    expect(validateTriggerContext(null)).toEqual({ ok: true, value: {} });
    expect(validateTriggerContext({})).toEqual({ ok: true, value: {} });
  });

  it("accepts a plain JSON object and returns a fresh, equal copy", () => {
    const input = { projectId: "p_1", count: 3, nested: { a: [1, true, null] } };
    const result = validateTriggerContext(input);

    expect(result).toEqual({ ok: true, value: input });
    if (result.ok) {
      expect(result.value).not.toBe(input);
      expect(result.value.nested).not.toBe(input.nested);
    }
  });

  it("rejects a non-object root (array, string, number, boolean)", () => {
    for (const bad of [["x"], "x", 1, true] as unknown[]) {
      expect(validateTriggerContext(bad).ok).toBe(false);
    }
  });

  it("rejects every reserved tenant/identity/prototype key, at the root", () => {
    for (const key of FORBIDDEN_TRIGGER_CONTEXT_KEYS) {
      const result = validateTriggerContext({ [key]: "x" });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects a reserved key nested inside the tree", () => {
    const result = validateTriggerContext({ a: { b: { orgId: "x" } } });
    expect(result.ok).toBe(false);
  });

  it("rejects values that JSON cannot represent (function, Date, undefined, NaN)", () => {
    expect(validateTriggerContext({ f: () => 1 }).ok).toBe(false);
    expect(validateTriggerContext({ d: new Date() }).ok).toBe(false);
    expect(validateTriggerContext({ u: undefined }).ok).toBe(false);
    expect(validateTriggerContext({ n: Number.NaN }).ok).toBe(false);
    expect(validateTriggerContext({ i: Number.POSITIVE_INFINITY }).ok).toBe(false);
  });

  it("rejects a non-plain nested object (class instance)", () => {
    class Thing {
      value = 1;
    }
    expect(validateTriggerContext({ t: new Thing() }).ok).toBe(false);
  });

  it("rejects a cyclic reference", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(validateTriggerContext(cyclic).ok).toBe(false);
  });

  it("rejects a tree deeper than the maximum depth", () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i <= MAX_TRIGGER_CONTEXT_DEPTH + 1; i++) {
      const next: Record<string, unknown> = {};
      deep.child = next;
      deep = next;
    }
    expect(validateTriggerContext(root).ok).toBe(false);
  });

  it("rejects a context that exceeds the value-count bound", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 400; i++) wide[`k${i}`] = i;
    expect(validateTriggerContext(wide).ok).toBe(false);
  });
});
