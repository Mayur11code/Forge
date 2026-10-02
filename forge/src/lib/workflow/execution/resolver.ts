// src/lib/workflow/execution/resolver.ts

import type { JsonValue } from "@/lib/workflow-types/type";

/**
 * Helper utility to securely fetch nested values from the Context JSON.
 * e.g., getValueByPath(context, "action_1.outputs.taskId")
 *
 * Returns `undefined` for any step that leaves the JSON tree rather than
 * throwing, because a pointer into a partially-populated context is an ordinary
 * condition during execution, not an exceptional one.
 *
 * Arrays are traversable by numeric segment (`steps.0.id`) because the context is
 * plain JSON and `arr["0"]` resolves at runtime. That is spelled out here
 * instead of leaning on an untyped index, so a non-numeric segment into an array
 * stops deterministically rather than depending on JS coercion.
 */
function getValueByPath(obj: JsonValue, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = obj;

  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }

    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index)) {
        return undefined;
      }
      current = current[index];
      continue;
    }

    current = current[part];
  }

  return current;
}

/**
 * THE POINTER ENGINE
 * Recursively scans configured inputs and replaces {{pointers}} with real data.
 */
export function resolveInputs(
  configuredInputs: Record<string, JsonValue>,
  globalContext: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const resolved: Record<string, JsonValue> = {};

  for (const [key, rawValue] of Object.entries(configuredInputs)) {
    resolved[key] = resolveValue(rawValue, globalContext);
  }

  return resolved;
}

function resolveValue(
  value: JsonValue,
  globalContext: Record<string, JsonValue>,
): JsonValue {
  if (typeof value === "string") {
    const pointerRegex = /\{\{([\w.-]+)\}\}/g;

    // If we do standard string replacement, it becomes "[object Object]". We want the actual object.
    const exactMatch = value.match(/^\{\{([\w.-]+)\}\}$/);
    if (exactMatch) {
      const path = exactMatch[1];
      const extractedValue = getValueByPath(globalContext, path);
      return extractedValue !== undefined ? extractedValue : value;
    }

    // STANDARD CASE: String interpolation (e.g., "Hello {{name}}, your ID is {{id}}")
    return value.replace(pointerRegex, (_match, path: string) => {
      const extractedValue = getValueByPath(globalContext, path);

      if (extractedValue === undefined || extractedValue === null) {
        return ""; // Or throw an error if you want strict failure on missing variables
      }

      // Coerce objects/arrays to strings if they are embedded inside a larger string
      return typeof extractedValue === "object"
        ? JSON.stringify(extractedValue)
        : String(extractedValue);
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, globalContext));
  }

  if (value !== null && typeof value === "object") {
    const resolvedObj: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) {
      resolvedObj[k] = resolveValue(v, globalContext);
    }
    return resolvedObj;
  }

  return value;
}