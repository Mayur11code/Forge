"use client";

import { useState, useCallback, useRef } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  getOutgoers, // Utility to find connected nodes (for tree traversal)
  useReactFlow,
  type Connection,
} from '@xyflow/react';

import { autoMapNodeVariables, getNodeDefinition } from '@/lib/workflow/graph-ui/utils';
import { ActionDef } from '@/lib/workflow-types/registry';
// import { toast } from "sonner"; // Or whatever toast library you use

import { saveWorkflowState, updateWorkflowState } from '@/app/actions/workflows/workflow';
import { useRouter, useParams } from 'next/navigation';
import { useTransition } from 'react';

// import '@xyflow/react/dist/style.css'; // Import React Flow style

// 1. Import our custom nodes and types!
import TriggerNode from './nodes/TriggerNode';
import ActionNode from './nodes/ActionNode';
import type { AppNode, AppEdge } from '@/lib/workflow-types/workflow'; // Import the union type for all nodes
import Sidebar from './sidebar';
import { Loader2, Save } from 'lucide-react'; // Ensure AppEdge is imported
import { init } from 'next/dist/compiled/webpack/webpack';
import PropertiesPanel from './PropertiesPanel';

interface WorkflowCanvasProps {
  workflowId?: string; // If undefined, we are creating a new one
  initialNodes?: AppNode[];
  initialEdges?: AppEdge[];
}


// 2. Register the nodes OUTSIDE the component so they don't re-render infinitely
const nodeTypes = {
  trigger: TriggerNode,
  action: ActionNode,
};

// 3. We create an internal component to use the `useReactFlow` hook safely
function CanvasArea({ workflowId, initialNodes, initialEdges }: WorkflowCanvasProps) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<AppNode>(initialNodes || []);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges || []);
  const { screenToFlowPosition, getNodes } = useReactFlow();


  // --- ENTERPRISE GUARDRAIL: Cycle Detection ---
  const isValidConnection = useCallback(
    (connection: Connection | AppEdge) => {
      // 1. Prevent self-loops (node connecting to itself)
      if (connection.source === connection.target) return false;

      const targetNode = nodes.find((n) => n.id === connection.target);
      // THis is a sanity check. In theory, React Flow shouldn't even allow this 
      // connection to be attempted since the target node wouldn't 
      // exist in the first place. But we check just in case!
      if (!targetNode) return false;
      //

      // 2. Prevent infinite loops (cycles)
      // We check if connecting [source] -> [target] creates a loop.
      // It's a loop if the [source] is ALREADY a downstream descendant of [target].
      const hasCycle = (node: AppNode, visited = new Set<string>()): boolean => {
        //earlier you used Node: node but this is wrong since typescript already have a node type in scope. You should use a different variable name to avoid confusion.
        if (visited.has(node.id)) return false;
        visited.add(node.id);

        // getOutgoers instantly fetches the immediate downstream children
        const outgoers = getOutgoers(node, nodes, edges);
        for (const outgoer of outgoers) {
          if (outgoer.id === connection.source) return true; // Cycle detected!
          if (hasCycle(outgoer, visited)) return true;
        }
        return false;
      };

      if (hasCycle(targetNode)) {
        // Optional: you can use a toast notification here instead of an alert
        alert("Action blocked: This connection would create an infinite loop.");
        return false;
      }

      return true; // Connection is valid!
    },
    [nodes, edges]
  );

const onConnect = useCallback(
    (connection: Connection) => {
      // 1. Draw the visual wire on the canvas immediately
      setEdges((eds) => addEdge(connection, eds));

      // 2. Trigger the "Self-Healing" Auto-Mapper
      // We wrap this in setEdges to ensure the utility has access to the 
      // edge list that INCLUDES the wire we just drew.
      setEdges((currentEdges) => {
        autoMapNodeVariables(
          connection.target, // The receiver of the wire
          getNodes() as AppNode[], 
          currentEdges, 
          setNodes
        );
        return currentEdges;
      });
    },
    [getNodes, setEdges, setNodes]
  );

  // Allows the canvas to accept dropped items
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  // The math: What happens when the user lets go of the mouse
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      const type = event.dataTransfer.getData('application/reactflow');
      if (!type) return;

      // --- ENTERPRISE GUARDRAIL: Single Entry Point ---
      if (type === 'trigger') {
        // FIX: Use getNodes() to get the absolute latest state, bypassing the stale closure!
        const currentNodes = getNodes();
        const alreadyHasTrigger = currentNodes.some((n) => n.type === 'trigger');
        if (alreadyHasTrigger) {
          alert("Workflows can only have one Trigger event.");
          return; // Drop rejected!
        }
      }

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const newNodeId = `${type}_${Date.now()}`;

      // Declare the variable with our strict type first
      let newNode: AppNode;

      // Use explicit if/else so TypeScript can "narrow" the type safely
      if (type === 'trigger') {
        newNode = {
          id: newNodeId,
          type: 'trigger',
          position,
          data: { label: 'New Trigger', eventId: null },
        };
      } else if (type === 'action') {
        newNode = {
          id: newNodeId,
          type: 'action',
          position,
          data: { label: 'New Action', actionType: 'unset', config: {}, isConfigured: false, isCritical: false },
        };
      } else {
        return; // Failsafe in case a rogue drag event occurs
      }

      setNodes((nds) => nds.concat(newNode));
    },
    [screenToFlowPosition, setNodes]
  );


  const router = useRouter();
  const params = useParams();
  const [isPending, startTransition] = useTransition();


  const handleSave = () => {
    startTransition(async () => {
      const orgId = params.orgId as string;

      // If we have a workflowId, we are EDITING an existing DAG
      if (workflowId) {
        const result = await updateWorkflowState(orgId, workflowId, nodes, edges);
        if (result.success) alert("Workflow Updated!");
        else alert("Failed to update.");
      }
      // Otherwise, we are CREATING a brand new DAG
      else {
        const result = await saveWorkflowState(orgId, "My First Automation", nodes, edges);
        if (result.success) {
          alert("Workflow Created!");
          // Redirect to the Edit page so they aren't stuck on the /new page
          router.push(`/org/${orgId}/workflows/${result.workflowId}`);
        } else {
          alert("Failed to save.");
        }
      }
    });
  };

  return (
    <div className="flex-grow h-[80vh]" ref={reactFlowWrapper}>

      {/* Sleek Floating Save Button */}
      <div className="absolute top-4 right-4 z-10">
        <button
          onClick={handleSave}
          disabled={isPending || nodes.length === 0}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-lg transition-all hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isPending ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          {isPending ? 'Saving...' : 'Save Canvas'}
        </button>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onDrop={onDrop}
        onDragOver={onDragOver}
        isValidConnection={isValidConnection}
        nodeTypes={nodeTypes}
        fitView
        colorMode='dark'
      >
        <Background gap={16} size={1} color="#3f3f46" />
        <Controls />
      </ReactFlow>
    </div>
  );
}

// 4. The Main Export wrapped in a Provider
export default function WorkflowBuilder(props: WorkflowCanvasProps) {
  return (
    <div className="flex w-full border-grey-800 rounded-xl overflow-hidden shadow-sm">
      <Sidebar />
      {/* The Provider is REQUIRED so CanvasArea can use the screenToFlowPosition hook */}
      <ReactFlowProvider>
        <CanvasArea {...props} />
        <PropertiesPanel />
      </ReactFlowProvider>
    </div>
  );
}