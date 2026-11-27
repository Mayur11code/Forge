"use client";

import { useCallback, useRef, useState, useTransition } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Controls,
  Background,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  getOutgoers,
  useReactFlow,
  type Connection,
} from '@xyflow/react';
import { useRouter, useParams } from 'next/navigation';
import { toast } from 'sonner';

import { autoMapNodeVariables } from '@/lib/workflow/graph-ui/utils';
import { saveWorkflowState, updateWorkflowState } from '@/app/actions/workflows/workflow';
import TriggerNode from './nodes/TriggerNode';
import ActionNode from './nodes/ActionNode';
import type { AppNode, AppEdge } from '@/lib/workflow-types/workflow';
import Sidebar from './sidebar';
import PropertiesPanel from './PropertiesPanel';
import WorkflowEditorHeader from './WorkflowEditorHeader';

interface WorkflowCanvasProps {
  workflowId?: string;
  initialName?: string;
  initialDescription?: string | null;
  initialNodes?: AppNode[];
  initialEdges?: AppEdge[];
}

const nodeTypes = {
  trigger: TriggerNode,
  action: ActionNode,
};

function CanvasArea({
  workflowId,
  initialName = 'Untitled workflow',
  initialDescription = null,
  initialNodes,
  initialEdges,
}: WorkflowCanvasProps) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<AppNode>(initialNodes || []);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges || []);
  const { screenToFlowPosition, getNodes } = useReactFlow();

  const [workflowName, setWorkflowName] = useState(initialName);
  const [workflowDescription, setWorkflowDescription] = useState<string | null>(
    initialDescription ?? null,
  );

  const params = useParams();
  const orgId = params.orgId as string;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const isValidConnection = useCallback(
    (connection: Connection | AppEdge) => {
      if (connection.source === connection.target) return false;

      const targetNode = nodes.find((n) => n.id === connection.target);
      if (!targetNode) return false;

      const hasCycle = (node: AppNode, visited = new Set<string>()): boolean => {
        if (visited.has(node.id)) return false;
        visited.add(node.id);

        const outgoers = getOutgoers(node, nodes, edges);
        for (const outgoer of outgoers) {
          if (outgoer.id === connection.source) return true;
          if (hasCycle(outgoer, visited)) return true;
        }
        return false;
      };

      if (hasCycle(targetNode)) {
        toast.error('Connection blocked: this would create a cycle in the workflow.');
        return false;
      }

      return true;
    },
    [nodes, edges],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => addEdge(connection, eds));

      setEdges((currentEdges) => {
        autoMapNodeVariables(connection.target, currentEdges, setNodes);
        return currentEdges;
      });
    },
    [setEdges, setNodes],
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
        const currentNodes = getNodes();
        const alreadyHasTrigger = currentNodes.some((n) => n.type === 'trigger');
        if (alreadyHasTrigger) {
          toast.error('Workflows can only have one Trigger event.');
          return;
        }
      }

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const newNodeId = `${type}_${Date.now()}`;
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
          data: {
            label: 'New Action',
            actionType: 'unset',
            config: {},
            isConfigured: false,
            isCritical: false,
          },
        };
      } else {
        return;
      }

      setNodes((nds) => nds.concat(newNode));
    },
    [getNodes, screenToFlowPosition, setNodes],
  );

  const persistWorkflow = (
    nextName: string,
    nextDescription: string | null,
    isMetadataOnlySave: boolean,
  ) => {
    if (isPending) return;

    startTransition(async () => {
      try {
        if (workflowId) {
          const result = await updateWorkflowState(
            orgId,
            workflowId,
            nodes,
            edges,
            { name: nextName, description: nextDescription },
          );
          if (result.success) {
            setWorkflowName(nextName);
            setWorkflowDescription(nextDescription);
            toast.success(
              isMetadataOnlySave ? 'Workflow metadata updated.' : 'Workflow saved.',
            );
          } else {
            toast.error(result.error || 'Failed to update workflow.');
          }
        } else {
          const result = await saveWorkflowState(
            orgId,
            nextName,
            nodes,
            edges,
            nextDescription,
          );
          if (result.success) {
            toast.success('Workflow created.');
            router.push(`/org/${orgId}/workflows/${result.workflowId}`);
          } else {
            toast.error(result.error || 'Failed to create workflow.');
          }
        }
      } catch {
        toast.error('Network error while saving workflow. Please try again.');
      }
    });
  };

  const handleCommitName = (nextName: string) => {
    setWorkflowName(nextName);
    if (workflowId && nodes.length > 0) {
      persistWorkflow(nextName, workflowDescription, true);
    }
  };

  const handleCommitDescription = (nextDescription: string | null) => {
    setWorkflowDescription(nextDescription);
    if (workflowId && nodes.length > 0) {
      persistWorkflow(workflowName, nextDescription, true);
    }
  };

  const handleSave = () => {
    persistWorkflow(workflowName, workflowDescription, false);
  };

  return (
    <div className="flex flex-1 flex-col h-full min-w-0" ref={reactFlowWrapper}>
      <WorkflowEditorHeader
        workflowId={workflowId}
        orgId={orgId}
        name={workflowName}
        description={workflowDescription}
        isPending={isPending}
        canSave={nodes.length > 0}
        onCommitName={handleCommitName}
        onCommitDescription={handleCommitDescription}
        onSave={handleSave}
      />

      <div className="relative flex-1 min-h-0">
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
          colorMode="dark"
        >
          <Background gap={16} size={1} color="#3f3f46" />
          <Controls />
          <MiniMap
            pannable
            zoomable
            bgColor="#09090b"
            maskColor="rgba(0, 0, 0, 0.72)"
            nodeColor={(node) => (node.type === 'trigger' ? '#10b981' : '#3b82f6')}
            className="!bg-zinc-950 !border !border-zinc-800 !rounded-lg"
          />
        </ReactFlow>
      </div>
    </div>
  );
}

export default function WorkflowBuilder(props: WorkflowCanvasProps) {
  return (
    <div className="flex h-full w-full border border-zinc-800 rounded-xl overflow-hidden shadow-sm">
      <Sidebar />
      <ReactFlowProvider>
        <CanvasArea {...props} />
        <PropertiesPanel />
      </ReactFlowProvider>
    </div>
  );
}
