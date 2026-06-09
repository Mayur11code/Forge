
import {
  AppNode,
  AppEdge,
} from "@/lib/workflow-types/workflow";

import {
  ActionDef,
  AVAILABLE_ACTIONS,
  AVAILABLE_TRIGGERS,
} from "@/lib/workflow-types/registry";


export function getNodeDefinition(node: AppNode) {
  if (
    node.type === "trigger" &&
    node.data.eventId
  ) {
    return AVAILABLE_TRIGGERS.find(
      (t) => t.id === node.data.eventId
    );
  }

  if (
    node.type === "action" &&
    node.data.actionType
  ) {
    return AVAILABLE_ACTIONS.find(
      (a) => a.id === node.data.actionType
    );
  }

  return null;
}


//recursively walks the graph upwards and return all available outputs
export function getAvailableUpstreamOutputs(
  targetNodeId: string,
  nodes: AppNode[],
  edges: AppEdge[],
  visited = new Set<string>()
): {
  sourceNodeId: string;
  outputKey: string;
}[] {


  if (visited.has(targetNodeId)) {
    return [];
  }

  visited.add(targetNodeId);


  //for o1 lookup
  const nodeMap = new Map(
    nodes.map((n) => [n.id, n])
  );

  //adjecency list for incoming edges to quickly find parents of a node
  const incomingEdgeMap =
    new Map<string, AppEdge[]>();

  for (const edge of edges) {
    const existing =
      incomingEdgeMap.get(edge.target) ?? [];

    existing.push(edge);

    incomingEdgeMap.set(
      edge.target,
      existing
    );
  }


  const resolvedOutputs = new Map<string, { sourceNodeId: string; outputKey: string; }>();


  const traverse = (
    nodeId: string,
    depth: number
  ) => {
    const incomingEdges =
      incomingEdgeMap.get(nodeId) ?? [];

    for (const edge of incomingEdges) {
      const parentNode =
        nodeMap.get(edge.source);

      if (!parentNode) continue;

      if (visited.has(parentNode.id)) {
        continue;
      }

      visited.add(parentNode.id);

      const parentDef =
        getNodeDefinition(parentNode);


      if (parentDef?.outputs?.length) {
        for (const outputKey of parentDef.outputs) {
          const key =
            `${parentNode.id}.${outputKey}`;

          if (!resolvedOutputs.has(key)) {
            resolvedOutputs.set(key, {
              sourceNodeId:
                parentNode.id,
              outputKey,
            });
          }
        }
      }

      /**
       * Recursive traversal upward
       */
      traverse(parentNode.id, depth + 1);
    }
  };

  traverse(targetNodeId, 0);

  return Array.from(
    resolvedOutputs.values()
  );
}



export function autoMapNodeVariables(
  targetNodeId: string,
  edges: AppEdge[],
  setNodes: (
    payload:
      | AppNode[]
      | ((
        nds: AppNode[]
      ) => AppNode[])
  ) => void
) {
  setNodes((nds) => {

    const nodeMap = new Map(
      nds.map((n) => [n.id, n])
    );

    const targetNode =
      nodeMap.get(targetNodeId);


    if (
      !targetNode ||
      targetNode.type !== "action"
    ) {
      return nds;
    }

    const targetDef =
      getNodeDefinition(
        targetNode
      ) as ActionDef | null;

    if (!targetDef?.requires?.length) {
      return nds;
    }

    const updatedConfig = {
      ...targetNode.data.config,
    };

    let hasChanges = false;

    const availableOutputs =
      getAvailableUpstreamOutputs(
        targetNodeId,
        nds,
        edges
      );


    for (const requiredInput of targetDef.requires) {

      const existingValue =
        updatedConfig[
        requiredInput
        ];

      const isEmpty =
        existingValue == null ||
        String(existingValue)
          .trim() === "";

      if (!isEmpty) {
        continue;
      }


      const provider =
        availableOutputs.find(
          (output) =>
            output.outputKey ===
            requiredInput
        );

      if (!provider) {
        continue;
      }

      const providerNode =
        nodeMap.get(
          provider.sourceNodeId
        );

      const nodeId =
        providerNode?.type ===
          "trigger"
          ? "trigger"
          : provider.sourceNodeId;


      updatedConfig[
        requiredInput
      ] =
        `{{${nodeId}.outputs.${requiredInput}}}`;

      hasChanges = true;
    }


    if (!hasChanges) {
      return nds;
    }


    return nds.map((node) => {
      if (
        node.id === targetNodeId &&
        node.type === "action"
      ) {
        return {
          ...node,
          data: {
            ...node.data,
            config:
              updatedConfig,
          },
        };
      }

      return node;
    });
  });
}