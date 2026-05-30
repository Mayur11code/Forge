"use client";

import { useNodesState, useEdgesState, } from '@xyflow/react';
import { useEffect } from 'react';
import { ReactFlow, ReactFlowProvider, Background, Controls } from '@xyflow/react';
import type { AppNode, AppEdge } from '@/lib/workflow-types/workflow';

import TriggerNode from './nodes/TriggerNode';
import ActionNode from './nodes/ActionNode';
import { useWorkflowLiveStream } from '@/hooks/useWorkflowLiveStream';
import ExecutionEdge from "./edges/ExecutionEdge";

const edgeTypes = {
  execution: ExecutionEdge,
};

// Use the exact same custom nodes so the visual design is identical
const nodeTypes = {
  trigger: TriggerNode,
  action: ActionNode,
};

interface WorkflowLiveViewerProps {
  runId: string;
  initialNodes: AppNode[];
  initialEdges: AppEdge[];
  onNodesUpdate: (nodes: AppNode[]) => void; // Callback to update parent state when nodes change
}

function LiveCanvasArea({ runId, initialNodes, initialEdges, onNodesUpdate }: WorkflowLiveViewerProps) {
  // We still use local state so the SSE hook can update the nodes in real-time
  const [nodes, setNodes, onNodesChange] = useNodesState<AppNode>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<AppEdge>(initialEdges);


  useEffect(() => {
    onNodesUpdate?.(nodes);
  }, [nodes, onNodesUpdate]);

  // 🔌 THE MAGIC HOOK: This listens to Redis and calls setNodes automatically
  useWorkflowLiveStream(runId, setNodes);

 useEffect(() => {
  setEdges((eds) =>
    eds.map((edge) => {
      const source = nodes.find(
        (n) => n.id === edge.source
      );

      const target = nodes.find(
        (n) => n.id === edge.target
      );

      const sourceStatus =
        source?.data.executionStatus;

      const targetStatus =
        target?.data.executionStatus;

      const isActive =
        targetStatus === "RUNNING";

      const isCompleted =
        sourceStatus === "SUCCESS" &&
        (
          targetStatus === "SUCCESS" ||
          targetStatus === "RUNNING"
        );

      const isFailed =
        targetStatus === "FAILED";

      return {
        ...edge,

        animated: isActive,

        style: {
          ...(edge.style ?? {}),

          stroke: isFailed
            ? "#ef4444"
            : isActive
            ? "#facc15"
            : isCompleted
            ? "#10b981"
            : "#3f3f46",

          strokeWidth: isActive ? 3 : 2,
          opacity: 1,
        },
      };
    })
  );
}, [nodes, setEdges]);

  return (
    <div className="flex-grow h-[80vh] w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        edgeTypes={edgeTypes}
        // Notice we still pass these so the user can pan around the canvas
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        colorMode="dark"
        // 🔒 ENTERPRISE GUARDRAILS: Lock the canvas down!
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={true} // Allow them to click nodes to see details, but not move them
      >
        <Background gap={16} size={1} color="#3f3f46" />
        <Controls />
      </ReactFlow>
    </div>
  );
}

// Wrap in Provider just like the Builder
export default function WorkflowLiveViewer(props: WorkflowLiveViewerProps) {
  return (
    <div className="flex w-full border-grey-800 rounded-xl overflow-hidden shadow-sm">
      {/* Notice: No Sidebar, No Properties Panel, No Save Button! */}
      <ReactFlowProvider>
        <LiveCanvasArea {...props} />
      </ReactFlowProvider>
    </div>
  );
}