// src/lib/workflow/utils.ts

import {
  AppNode,
  AppEdge,
} from "@/lib/workflow-types/workflow";

import {
  ActionDef,
  AVAILABLE_ACTIONS,
  AVAILABLE_TRIGGERS,
} from "@/lib/workflow-types/registry";

/**
 * ============================================================
 * Node Definition Resolver
 * ============================================================
 */

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

/**
 * ============================================================
 * Upstream Output Scanner
 *
 * Recursively walks the graph upward and
 * returns all available outputs.
 *
 * Priority:
 * Direct Parent > Grandparent > Higher Ancestors
 *
 * Prevents:
 * - infinite loops
 * - duplicate outputs
 * - unstable ordering
 *
 * ============================================================
 */

export function getAvailableUpstreamOutputs(
  targetNodeId: string,
  nodes: AppNode[],
  edges: AppEdge[],
  visited = new Set<string>()
): {
  sourceNodeId: string;
  outputKey: string;
}[] {
  /**
   * Cycle protection
   */
  if (visited.has(targetNodeId)) {
    return [];
  }

  visited.add(targetNodeId);

  /**
   * Fast lookup maps
   *
   * O(1) instead of repeated O(n)
   */
  const nodeMap = new Map(
    nodes.map((n) => [n.id, n])
  );

  /**
   * Build parent adjacency list
   *
   * target -> incoming edges
   */
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

  /**
   * Stores resolved outputs.
   *
   * Key:
   * sourceNodeId.outputKey
   *
   * Preserves insertion order.
   */
  const resolvedOutputs =
    new Map<
      string,
      {
        sourceNodeId: string;
        outputKey: string;
      }
    >();

  /**
   * DFS traversal
   *
   * depth matters:
   * lower depth = higher priority
   */
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

      /**
       * Prevent cycles
       */
      if (visited.has(parentNode.id)) {
        continue;
      }

      visited.add(parentNode.id);

      const parentDef =
        getNodeDefinition(parentNode);

      /**
       * Add direct parent outputs FIRST
       *
       * This guarantees:
       * Parent > Grandparent
       */
      if (parentDef?.outputs?.length) {
        for (const outputKey of parentDef.outputs) {
          const key =
            `${parentNode.id}.${outputKey}`;

          /**
           * First write wins.
           *
           * Closer ancestors
           * always have priority.
           */
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

/**
 * ============================================================
 * Auto Variable Mapper
 *
 * Automatically injects:
 *
 * {{node.outputs.key}}
 *
 * Resolution Priority:
 *
 * 1. Direct parent
 * 2. Grandparent
 * 3. Higher ancestors
 *
 * Existing config values are never overwritten.
 * ============================================================
 */

export function autoMapNodeVariables(
  targetNodeId: string,
  nodes: AppNode[],
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
    /**
     * Fast node lookup
     */
    const nodeMap = new Map(
      nds.map((n) => [n.id, n])
    );

    const targetNode =
      nodeMap.get(targetNodeId);

    /**
     * Only actions require inputs
     */
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

    /**
     * Clone config
     * Never mutate original
     */
    const updatedConfig = {
      ...targetNode.data.config,
    };

    let hasChanges = false;

    /**
     * Get ALL upstream outputs
     *
     * Ordered by proximity.
     */
    const availableOutputs =
      getAvailableUpstreamOutputs(
        targetNodeId,
        nds,
        edges
      );

    /**
     * Resolve every required input
     */
    for (const requiredInput of targetDef.requires) {
      /**
       * Respect manual config.
       * Never overwrite.
       */
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

      /**
       * Find nearest provider
       *
       * Parent first.
       * Grandparent fallback.
       */
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

      /**
       * Inject variable syntax
       */
      updatedConfig[
        requiredInput
      ] =
        `{{${nodeId}.outputs.${requiredInput}}}`;

      hasChanges = true;
    }

    /**
     * No update → avoid rerender
     */
    if (!hasChanges) {
      return nds;
    }

    /**
     * Immutable update
     */
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