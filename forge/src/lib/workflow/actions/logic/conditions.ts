// src/lib/workflow/actions/logic/condition.ts

export async function executeConditionNode(inputs: Record<string, any>) {
  // Inputs are already resolved by the wrapper! 
  // e.g., value1: 150, operator: ">", value2: 100
  const { value1, operator, value2 } = inputs;

  let result = false;

  // Convert to strings for safe comparison, or parse numbers if needed
  const v1 = Number(value1) || value1;
  const v2 = Number(value2) || value2;

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

  // --- THE CRITICAL OUTPUT ---
  // The engine evaluator is going to look for this exact 'branch' key.
  return {
    success: true,
    outputs: {
      branch: result ? "TRUE" : "FALSE", 
      details: `${v1} ${operator} ${v2} evaluated to ${result}`
    }
  };
}