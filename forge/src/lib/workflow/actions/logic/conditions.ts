// src/lib/workflow/actions/logic/condition.ts

import type { JsonValue } from "@/lib/workflow-types/type";

type Comparable = number | string;

/**
 * Coerces a resolved input into something two operands can be compared with.
 *
 * A pointer may resolve to a number, a numeric string, a boolean, or a whole
 * object depending on what the parent step returned, so the comparison has to
 * pick a representation first.
 *
 * The previous `Number(value) || value` was wrong for zero: `Number(0)` and
 * `Number("0")` are both falsy, so a value of 0 fell through to the raw input and
 * compared as "0" against a real 0. That is invisible on `===` and quietly wrong
 * on every ordering operator.
 */
function toComparable(value: JsonValue): Comparable {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "boolean") {
    return String(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed !== "" && !Number.isNaN(Number(trimmed))
      ? Number(trimmed)
      : value;
  }

  // Objects and arrays are compared by their JSON form, which is the only
  // rendering of them that a CONTAINS check can mean anything by.
  return JSON.stringify(value);
}

export async function executeConditionNode(inputs: Record<string, JsonValue>) {
  // Inputs are already resolved by the wrapper!
  // e.g., value1: 150, operator: ">", value2: 100
  const { value1, operator, value2 } = inputs;

  if (typeof operator !== "string") {
    throw new Error(
      `Condition node requires an operator string; received ${typeof operator}.`,
    );
  }

  const v1 = toComparable(value1);
  const v2 = toComparable(value2);

  let result = false;

  switch (operator) {
    case "===":
    case "==":
      result = v1 === v2;
      break;
    case "!==":
    case "!=":
      result = v1 !== v2;
      break;
    case ">":
      result = v1 > v2;
      break;
    case "<":
      result = v1 < v2;
      break;
    case ">=":
      result = v1 >= v2;
      break;
    case "<=":
      result = v1 <= v2;
      break;
    case "CONTAINS":
      // Substring semantics over the rendered form, so a CONTAINS check against a
      // numeric value ("150" contains "15") behaves the way the editor implies.
      result = String(v1).includes(String(v2));
      break;
    default:
      throw new Error(`Unsupported operator: ${operator}`);
  }

  // --- THE CRITICAL OUTPUT ---
  // The engine evaluator is going to look for this exact 'branch' key, reading it
  // out of StepRun.outputs. The wrapper populates that column from ActionResult
  // .data, so the payload is returned under `data` - returning `outputs` here,
  // as this action used to, left the column empty and every dependant took the
  // FALSE branch regardless of the comparison.
  return {
    success: true,
    data: {
      branch: result ? "TRUE" : "FALSE",
      details: `${v1} ${operator} ${v2} evaluated to ${result}`,
    },
  };
}