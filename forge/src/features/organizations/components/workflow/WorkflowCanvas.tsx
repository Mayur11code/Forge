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
  useReactFlow,
  type Connection,
} from '@xyflow/react';

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
function CanvasArea({workflowId, initialNodes, initialEdges}: WorkflowCanvasProps) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<AppNode>(initialNodes || []);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges || []);
  const { screenToFlowPosition } = useReactFlow();
  

  // Handles drawing lines between nodes
  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
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
          data: { label: 'New Action', actionType: 'unset', config: {}, isConfigured: false },
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
        const result = await updateWorkflowState(workflowId, nodes, edges);
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
      </ReactFlowProvider>
    </div>
  );
}