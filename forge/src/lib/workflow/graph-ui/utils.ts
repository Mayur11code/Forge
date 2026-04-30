// src/lib/workflow/utils.ts
import { AppNode, AppEdge } from "@/lib/workflow-types/workflow"; // Adjust path if needed
import { AVAILABLE_ACTIONS, AVAILABLE_TRIGGERS } from "@/lib/workflow-types/registry"; // Adjust path if needed

/**
 * Helper: Given a fully typed AppNode, find its definition in our registry
 * so we can read its 'outputs' and 'requires' arrays.
 */
export function getNodeDefinition(node: AppNode) {
  // Because AppNode is a discriminated union, TypeScript knows that if 
  // node.type === 'trigger', node.data MUST be TriggerNodeData.
  if (node.type === 'trigger' && node.data.eventId) {
    return AVAILABLE_TRIGGERS.find(t => t.id === node.data.eventId);
  }
  
  // Likewise, if it's an action, it safely has actionType.
  if (node.type === 'action' && node.data.actionType) {
    return AVAILABLE_ACTIONS.find(a => a.id === node.data.actionType);
  }
  
  return null;
}

/**
 * The Upstream Scanner: Recursively walks up the React Flow graph
 * to collect every variable available to the target node.
 */
export function getAvailableUpstreamOutputs(
  targetNodeId: string, 
  nodes: AppNode[], 
  edges: AppEdge[],
  visited = new Set<string>() // Guardrail against infinite loops!
): { sourceNodeId: string; outputKey: string }[] {
  
  // 1. Safety Check: Stop circular dependencies
  if (visited.has(targetNodeId)) return [];
  visited.add(targetNodeId);

  // 2. Find all wires pointing directly INTO our target node
  const incomingEdges = edges.filter(e => e.target === targetNodeId);
  let rawAvailableData: { sourceNodeId: string; outputKey: string }[] = [];

  for (const edge of incomingEdges) {
    // Grab the actual node component the wire is coming from
    const parentNode = nodes.find(n => n.id === edge.source);
    if (!parentNode) continue;

    // Look up the parent in your registry
    const parentDef = getNodeDefinition(parentNode);

    // 3. Extract the parent's immediate outputs
    if (parentDef && parentDef.outputs) {
      parentDef.outputs.forEach(outputKey => {
        rawAvailableData.push({ sourceNodeId: parentNode.id, outputKey });
      });
    }

    // 4. Recursively call this function on the parent to get grandparent outputs
    const grandparentData = getAvailableUpstreamOutputs(
      parentNode.id, 
      nodes, 
      edges, 
      visited
    );

    // Combine what the parent outputs with what the grandparents output
    rawAvailableData = [...rawAvailableData, ...grandparentData];
  }

  // 5. The Diamond Fix (Deduplication)
  const uniqueData = new Map();
  for (const item of rawAvailableData) {
    // Create a unique key like "node-1.taskId"
    const uniqueKey = `${item.sourceNodeId}.${item.outputKey}`;
    uniqueData.set(uniqueKey, item);
  }

  // Return the clean array
  return Array.from(uniqueData.values());
}