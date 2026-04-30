// src/lib/workflow/execution/resolver.ts

/**
 * Helper utility to securely fetch nested values from the Context JSON.
 * e.g., getValueByPath(context, "action_1.outputs.taskId")
 */
function getValueByPath(obj: any, path: string): any {
  return path.split('.').reduce((acc, part) => {
    if (acc && typeof acc === 'object') {
      return acc[part];
    }
    return undefined;
  }, obj);
}

/**
 * THE POINTER ENGINE
 * Recursively scans configured inputs and replaces {{pointers}} with real data.
 */
export function resolveInputs(
  configuredInputs: Record<string, any>,
  globalContext: Record<string, any>
): Record<string, any> {
  
  const resolved: Record<string, any> = {};

  for (const [key, rawValue] of Object.entries(configuredInputs)) {
    resolved[key] = resolveValue(rawValue, globalContext);
  }

  return resolved;
}

function resolveValue(value: any, globalContext: Record<string, any>): any {
  if (typeof value !== 'string' && typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, globalContext));
  }

  if (value !== null && typeof value === 'object') {
    const resolvedObj: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      resolvedObj[k] = resolveValue(v, globalContext);
    }
    return resolvedObj;
  }

  if (typeof value === 'string') {
    const pointerRegex = /\{\{([\w.-]+)\}\}/g;
    
    // If we do standard string replacement, it becomes "[object Object]". We want the actual object.
    const exactMatch = value.match(/^\{\{([\w.-]+)\}\}$/);
    if (exactMatch) {
      const path = exactMatch[1];
      const extractedValue = getValueByPath(globalContext, path);
      return extractedValue !== undefined ? extractedValue : value;
    }

    // STANDARD CASE: String interpolation (e.g., "Hello {{name}}, your ID is {{id}}")
    return value.replace(pointerRegex, (match, path) => {
      const extractedValue = getValueByPath(globalContext, path);
      
      if (extractedValue === undefined || extractedValue === null) {
        return ""; // Or throw an error if you want strict failure on missing variables
      }
      
      // Coerce objects/arrays to strings if they are embedded inside a larger string
      return typeof extractedValue === 'object' 
        ? JSON.stringify(extractedValue) 
        : String(extractedValue);
    });
  }

  return value;
}