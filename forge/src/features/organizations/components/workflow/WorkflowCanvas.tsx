"use client";

import { useCallback, useRef } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  getOutgoers, 
  useReactFlow,
  type Connection,
} from '@xyflow/react';

import RunWOrkflowButton from './RunWorkflowButton';

import { autoMapNodeVariables} from '@/lib/workflow/graph-ui/utils';


import { saveWorkflowState, updateWorkflowState } from '@/app/actions/workflows/workflow';
import { useRouter, useParams } from 'next/navigation';
import { useTransition } from 'react';



import TriggerNode from './nodes/TriggerNode';
import ActionNode from './nodes/ActionNode';
import type { AppNode, AppEdge } from '@/lib/workflow-types/workflow'; 
import Sidebar from './sidebar';
import { Loader2, Save } from 'lucide-react'; 
import PropertiesPanel from './PropertiesPanel';
import RunWorkflowButton from './RunWorkflowButton';
// import RunWorkflowButton from './RunWorkflowButton';

interface WorkflowCanvasProps {
  workflowId?: string; // undefined for new workflows
  initialNodes?: AppNode[];
  initialEdges?: AppEdge[];
}


// rerender prevention
const nodeTypes = {
  trigger: TriggerNode,
  action: ActionNode,
};

// internal component to use the useReactFlow hook safely
function CanvasArea({ workflowId, initialNodes, initialEdges }: WorkflowCanvasProps) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<AppNode>(initialNodes || []);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges || []);
  const { screenToFlowPosition, getNodes } = useReactFlow();

  const params = useParams();
  const orgId = params.orgId as string;


  const isValidConnection = useCallback(
    (connection: Connection | AppEdge) => {

      if (connection.source === connection.target) return false;

      const targetNode = nodes.find((n) => n.id === connection.target);
      // THis is a sanity check. In theory, React Flow shouldn't even allow this 

      if (!targetNode) return false;
  

  
      const hasCycle = (node: AppNode, visited = new Set<string>()): boolean => {
        if (visited.has(node.id)) return false;
        visited.add(node.id);

        const outgoers = getOutgoers(node, nodes, edges); //immediate downwnstream nodes
        for (const outgoer of outgoers) {
          if (outgoer.id === connection.source) return true; 
          if (hasCycle(outgoer, visited)) return true;
        }
        return false;
      };

      if (hasCycle(targetNode)) {
        alert("Action blocked: This connection would create an infinite loop.");
        return false;
      }

      return true;
    },
    [nodes, edges]
  );

const onConnect = useCallback(
    (connection: Connection) => {
   
      setEdges((eds) => addEdge(connection, eds));

    
      setEdges((currentEdges) => {
        autoMapNodeVariables(
          connection.target, 
          currentEdges, 
          setNodes
        );
        return currentEdges;
      });
    },
    [getNodes, setEdges, setNodes]
  );

 
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      const type = event.dataTransfer.getData('application/reactflow');
      if (!type) return;


      if (type === 'trigger') {
    
        const currentNodes = getNodes(); //to prevent stale closure issues
        const alreadyHasTrigger = currentNodes.some((n) => n.type === 'trigger');
        if (alreadyHasTrigger) {
          alert("Workflows can only have one Trigger event.");
          return; 
        }
      }

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const newNodeId = `${type}_${Date.now()}`;

      // Declare the variable with our strict type first
      let newNode: AppNode;

  
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

  const [isPending, startTransition] = useTransition();


  const handleSave = () => {
    startTransition(async () => {
      const orgId = params.orgId as string;

      
      if (workflowId) {
        const result = await updateWorkflowState(orgId, workflowId, nodes, edges);
        if (result.success) alert("Workflow Updated!");
        else alert("Failed to update.");
      }
    
      else {
        const result = await saveWorkflowState(orgId, "My First Automation", nodes, edges);
        if (result.success) {
          alert("Workflow Created!");
  
          //edit page
          router.push(`/org/${orgId}/workflows/${result.workflowId}`);
        } else {
          alert("Failed to save.");
        }
      }
    });
  };



  // The verification payload to check if the workflow is working as expected for the admin
  const mockProjectPayload = {
    projectId: `cmnj8u44p0003a0gcvqgt25dv`,
    projectName: "Forge Core",
    createdAt: new Date().toISOString(),
  };

  return (
    <div className="flex-grow h-[80vh]" ref={reactFlowWrapper}>

{/* Sleek Floating Action Bar */}
      <div className="absolute top-4 right-4 z-10 flex items-center gap-3">
        
        {/* Only show the Run button if the workflow exists in the database */}
        {workflowId && (
          <RunWorkflowButton 
            workflowId={workflowId} 
            orgId={orgId} 
            payload={mockProjectPayload} 
          />
        )}

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


export default function WorkflowBuilder(props: WorkflowCanvasProps) {
  return (
    <div className="flex w-full border-grey-800 rounded-xl overflow-hidden shadow-sm">
      <Sidebar />
      {/*CanvasArea can use the screenToFlowPosition hook */}
      <ReactFlowProvider>
        <CanvasArea {...props} />
        <PropertiesPanel />
      </ReactFlowProvider>
    </div>
  );
}