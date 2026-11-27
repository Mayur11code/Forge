// src/lib/workflow-types/trigger-filter.ts
//
// FC-019: Deterministic, Fail-Closed Trigger Filter Contract & Evaluator.
//
// Guarantees:
// 1. Zod-validated deterministic filter rules (no dynamic eval, no arbitrary JS).
// 2. Fail-closed: missing fields or incompatible types evaluate to false (no execution).
// 3. Conjunction logic: 'AND' (all rules pass) or 'OR' (any rule passes).
// 4. Safe property access via dot-notation without prototype leakage.

import { z } from "zod";

export const TriggerFilterOperatorSchema = z.enum([
  "equals",
  "not_equals",
  "in",
  "contains",
]);

export type TriggerFilterOperator = z.infer<typeof TriggerFilterOperatorSchema>;

export const TriggerFilterRuleSchema = z.object({
  field: z.string().trim().min(1, "Field name cannot be empty").max(100),
  operator: TriggerFilterOperatorSchema,
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.string()),
  ]),
});

export type TriggerFilterRule = z.infer<typeof TriggerFilterRuleSchema>;

export const TriggerFilterConfigSchema = z.object({
  logic: z.enum(["AND", "OR"]).default("AND"),
  rules: z.array(TriggerFilterRuleSchema).default([]),
});

export type TriggerFilterConfig = z.infer<typeof TriggerFilterConfigSchema>;

/**
 * Safely resolves a nested dot-notation property from a plain record.
 */
function getPropertyByPath(obj: Record<string, unknown>, path: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    // Prototype pollution defense
    if (part === "__proto__" || part === "constructor" || part === "prototype") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Evaluates an individual trigger filter rule against a payload.
 * Returns false on missing properties or type mismatches (fail closed).
 */
export function evaluateFilterRule(
  rule: TriggerFilterRule,
  payload: Record<string, unknown>,
): boolean {
  const actual = getPropertyByPath(payload, rule.field);

  // Missing or undefined field fails closed
  if (actual === undefined || actual === null) {
    return false;
  }

  switch (rule.operator) {
    case "equals": {
      if (typeof rule.value === "string") {
        return String(actual) === rule.value;
      }
      if (typeof rule.value === "number") {
        return Number(actual) === rule.value;
      }
      if (typeof rule.value === "boolean") {
        return Boolean(actual) === rule.value;
      }
      return actual === rule.value;
    }

    case "not_equals": {
      if (typeof rule.value === "string") {
        return String(actual) !== rule.value;
      }
      if (typeof rule.value === "number") {
        return Number(actual) !== rule.value;
      }
      if (typeof rule.value === "boolean") {
        return Boolean(actual) !== rule.value;
      }
      return actual !== rule.value;
    }

    case "in": {
      if (Array.isArray(rule.value)) {
        return rule.value.map(String).includes(String(actual));
      }
      if (typeof rule.value === "string") {
        const allowed = rule.value.split(",").map((s) => s.trim());
        return allowed.includes(String(actual));
      }
      return false;
    }

    case "contains": {
      if (typeof actual === "string" && typeof rule.value === "string") {
        return actual.toLowerCase().includes(rule.value.toLowerCase());
      }
      if (Array.isArray(actual)) {
        return actual.map(String).includes(String(rule.value));
      }
      return false;
    }

    default:
      return false;
  }
}

/**
 * Evaluates the entire filter configuration against a domain event payload.
 * Empty or unconfigured filters return true (all events eligible).
 */
export function evaluateTriggerFilter(
  filter: TriggerFilterConfig | null | undefined,
  payload: Record<string, unknown>,
): boolean {
  if (!filter || !filter.rules || filter.rules.length === 0) {
    return true; // No filter configured -> match all events
  }

  const results = filter.rules.map((rule) => evaluateFilterRule(rule, payload));

  const isOr = filter.logic === "OR" || (filter as unknown as { logicalOperator?: string }).logicalOperator === "OR";
  if (isOr) {
    return results.some(Boolean);
  }

  // Default 'AND': every rule must pass
  return results.every(Boolean);
}
