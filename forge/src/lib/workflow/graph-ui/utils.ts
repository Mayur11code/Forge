import {
  AppNode,
  AppEdge,
  type ActionNodeData,
  type TriggerNodeData,
} from "@/lib/workflow-types/workflow";

import {
  ActionDef,
  TriggerDef,
  AVAILABLE_ACTIONS,
  AVAILABLE_TRIGGERS,
} from "@/lib/workflow-types/registry";

type NodeDefinitionInput =
  | { type: "trigger"; data: TriggerNodeData }
  | { type: "action"; data: ActionNodeData };

export function getNodeDefinition(
  node: { type: "trigger"; data: TriggerNodeData },
): TriggerDef | undefined;
export function getNodeDefinition(
  node: { type: "action"; data: ActionNodeData },
): ActionDef | undefined;
export function getNodeDefinition(
  node: NodeDefinitionInput,
): TriggerDef | ActionDef | undefined;
export function getNodeDefinition(node: NodeDefinitionInput) {
  if (node.type === "trigger" && node.data.eventId) {
    return AVAILABLE_TRIGGERS.find((t) => t.id === node.data.eventId);
  }

  if (node.type === "action" && node.data.actionType) {
    return AVAILABLE_ACTIONS.find((a) => a.id === node.data.actionType);
  }

  return undefined;
}

export type UpstreamOutputOption = {
  sourceNodeId: string;
  sourceNodeType: "trigger" | "action";
  sourceNodeLabel: string;
  outputKey: string;
  expression: string;
};

export function formatVariableExpression(
  sourceNodeId: string,
  sourceNodeType: "trigger" | "action",
  outputKey: string,
): string {
  const prefix = sourceNodeType === "trigger" ? "trigger" : sourceNodeId;
  return `{{${prefix}.outputs.${outputKey}}}`;
}

/**
 * Recursively walks the graph upwards and returns all available upstream outputs.
 */
export function getAvailableUpstreamOutputs(
  targetNodeId: string,
  nodes: AppNode[],
  edges: AppEdge[],
  visited = new Set<string>(),
): UpstreamOutputOption[] {
  if (visited.has(targetNodeId)) {
    return [];
  }

  visited.add(targetNodeId);

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const incomingEdgeMap = new Map<string, AppEdge[]>();

  for (const edge of edges) {
    const existing = incomingEdgeMap.get(edge.target) ?? [];
    existing.push(edge);
    incomingEdgeMap.set(edge.target, existing);
  }

  const resolvedOutputs = new Map<string, UpstreamOutputOption>();

  const traverse = (nodeId: string) => {
    const incomingEdges = incomingEdgeMap.get(nodeId) ?? [];

    for (const edge of incomingEdges) {
      const parentNode = nodeMap.get(edge.source);
      if (!parentNode) continue;

      if (visited.has(parentNode.id)) {
        continue;
      }

      visited.add(parentNode.id);

      const parentDef = getNodeDefinition(parentNode);
      if (parentDef?.outputs?.length) {
        const sourceNodeType = parentNode.type;
        const sourceNodeLabel = parentNode.data.label || parentDef.label || parentNode.id;

        for (const outputKey of parentDef.outputs) {
          const key = `${parentNode.id}.${outputKey}`;
          if (!resolvedOutputs.has(key)) {
            resolvedOutputs.set(key, {
              sourceNodeId: parentNode.id,
              sourceNodeType,
              sourceNodeLabel,
              outputKey,
              expression: formatVariableExpression(parentNode.id, sourceNodeType, outputKey),
            });
          }
        }
      }

      traverse(parentNode.id);
    }
  };

  traverse(targetNodeId);

  return Array.from(resolvedOutputs.values());
}

/**
 * Auto-maps required inputs on `targetNodeId` from upstream outputs ONLY when:
 * 1. The target field is currently empty, AND
 * 2. Exactly one upstream provider exposes that `outputKey` (ambiguous providers
 *    are left unmapped so the user can choose explicitly in PropertiesPanel).
 */
export function autoMapNodeVariables(
  targetNodeId: string,
  edges: AppEdge[],
  setNodes: (
    payload: AppNode[] | ((nds: AppNode[]) => AppNode[]),
  ) => void,
) {
  setNodes((nds) => {
    const nodeMap = new Map(nds.map((n) => [n.id, n]));
    const targetNode = nodeMap.get(targetNodeId);

    if (!targetNode || targetNode.type !== "action") {
      return nds;
    }

    const targetDef = getNodeDefinition(targetNode);
    if (!targetDef?.requires?.length) {
      return nds;
    }

    const updatedConfig = {
      ...targetNode.data.config,
    };

    let hasChanges = false;
    const availableOutputs = getAvailableUpstreamOutputs(targetNodeId, nds, edges);

    for (const requiredInput of targetDef.requires) {
      const existingValue = updatedConfig[requiredInput];
      const isEmpty =
        existingValue == null || String(existingValue).trim() === "";

      if (!isEmpty) {
        continue;
      }

      const matchingProviders = availableOutputs.filter(
        (output) => output.outputKey === requiredInput,
      );

      // Ambiguous providers: do not silently pick an arbitrary upstream node.
      if (matchingProviders.length !== 1) {
        continue;
      }

      updatedConfig[requiredInput] = matchingProviders[0].expression;
      hasChanges = true;
    }

    if (!hasChanges) {
      return nds;
    }

    return nds.map((node) => {
      if (node.id === targetNodeId && node.type === "action") {
        return {
          ...node,
          data: {
            ...node.data,
            config: updatedConfig,
          },
        };
      }
      return node;
    });
  });
}
