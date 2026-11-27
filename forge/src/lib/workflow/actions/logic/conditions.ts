// src/lib/workflow/actions/logic/conditions.ts

import type { JsonValue, WorkflowAction, ExecuteFunction } from "@/lib/workflow-types/type";

type Comparable = number | string;

/**
 * Coerces a resolved input into something two operands can be compared with.
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

  return JSON.stringify(value);
}

export async function executeConditionNode(inputs: Record<string, JsonValue>) {
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
      result = String(v1).includes(String(v2));
      break;
    default:
      throw new Error(`Unsupported operator: ${operator}`);
  }

  return {
    success: true,
    data: {
      branch: result ? "TRUE" : "FALSE",
      details: `${v1} ${operator} ${v2} evaluated to ${result}`,
      conditionMet: result,
    },
  };
}

const execute: ExecuteFunction = async (ctx) => {
  try {
    return await executeConditionNode(ctx.inputs);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Condition evaluation failed",
      isRetriable: false,
    };
  }
};

export const conditionAction: WorkflowAction = {
  id: "logic.condition",
  version: "1.0.0",
  execute,
};
