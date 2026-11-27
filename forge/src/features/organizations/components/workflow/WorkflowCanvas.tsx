"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
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
import { Workflow } from 'lucide-react';

import { autoMapNodeVariables } from '@/lib/workflow/graph-ui/utils';
import {
  saveWorkflowState,
  updateWorkflowState,
  publishWorkflowAction,
  toggleWorkflowActiveAction,
} from '@/app/actions/workflows/workflow';
import { evaluateWorkflowDiagnostics } from '@/lib/workflow/validation/diagnostics';
import TriggerNode from './nodes/TriggerNode';
import ActionNode from './nodes/ActionNode';
import type { AppNode, AppEdge } from '@/lib/workflow-types/workflow';
import PropertiesPanel from './PropertiesPanel';
import WorkflowEditorHeader from './WorkflowEditorHeader';
import { WorkflowCanvasToolbar } from './WorkflowCanvasToolbar';
import { SimulationRightPanel } from './SimulationRightPanel';
import type { WorkflowSimulationResult } from '@/lib/workflow/execution/simulator';

interface WorkflowCanvasProps {
  workflowId?: string;
  initialName?: string;
  initialDescription?: string | null;
  initialNodes?: AppNode[];
  initialEdges?: AppEdge[];
  initialDraftRevision?: number;
  initialPublishedVersionNumber?: number | null;
  initialIsActive?: boolean;
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
  initialDraftRevision = 1,
  initialPublishedVersionNumber = null,
  initialIsActive = false,
}: WorkflowCanvasProps) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<AppNode>(initialNodes || []);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges || []);
  const { screenToFlowPosition, getNodes } = useReactFlow();

  const [workflowName, setWorkflowName] = useState(initialName);
  const [workflowDescription, setWorkflowDescription] = useState<string | null>(
    initialDescription ?? null,
  );
  const [draftRevision, setDraftRevision] = useState(initialDraftRevision);
  const [publishedVersionNumber, setPublishedVersionNumber] = useState<number | null>(
    initialPublishedVersionNumber,
  );
  const [isActive, setIsActive] = useState(initialIsActive);

  // Selected node state lifted for reliable drawer sync
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Simulation & Publish lifecycle states
  const [isSimulationOpen, setIsSimulationOpen] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isTogglingActive, setIsTogglingActive] = useState(false);
  const [isCanvasLocked, setIsCanvasLocked] = useState(false);

  // Unsaved baseline tracking
  const [savedBaseline, setSavedBaseline] = useState(() =>
    JSON.stringify({
      name: initialName,
      description: initialDescription,
      nodes: initialNodes || [],
      edges: initialEdges || [],
    }),
  );

  const currentBaseline = JSON.stringify({
    name: workflowName,
    description: workflowDescription,
    nodes,
    edges,
  });
  const hasUnsavedChanges = currentBaseline !== savedBaseline;

  // Realtime graph diagnostics
  const diagnostics = useMemo(
    () => evaluateWorkflowDiagnostics(nodes, edges),
    [nodes, edges],
  );

  const params = useParams();
  const orgId = params.orgId as string;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Realtime node data patcher: guarantees instant UI reflection & persistence sync
  const handleUpdateNodeData = useCallback(
    (nodeId: string, patch: Partial<AppNode['data']>) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== nodeId) return n;
          return {
            ...n,
            data: {
              ...n.data,
              ...patch,
            },
          } as AppNode;
        }),
      );
    },
    [setNodes],
  );

  // Node deletion handler
  const handleDeleteNode = useCallback(
    (nodeId: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== nodeId));
      setEdges((eds) =>
        eds.filter((e) => e.source !== nodeId && e.target !== nodeId),
      );
      setSelectedNodeId((cur) => (cur === nodeId ? null : cur));
      toast.success('Node deleted.');
    },
    [setNodes, setEdges],
  );

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

      // Auto-select the newly dropped node so the drawer opens immediately for configuration!
      setSelectedNodeId(newNodeId);
      setNodes((nds) =>
        nds
          .map((n) => ({ ...n, selected: false }))
          .concat({ ...newNode, selected: true }),
      );
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
            setDraftRevision((r) => r + 1);
            setSavedBaseline(
              JSON.stringify({
                name: nextName,
                description: nextDescription,
                nodes,
                edges,
              }),
            );
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

  const handlePublish = () => {
    if (isPublishing || isPending) return;
    if (!diagnostics.canPublish) {
      toast.error(diagnostics.errors[0]?.message || 'Cannot publish workflow with errors. Check diagnostics.');
      return;
    }

    setIsPublishing(true);
    startTransition(async () => {
      try {
        let targetWfId = workflowId;

        // Auto-save draft seamlessly if newly created or has unsaved changes
        if (!targetWfId) {
          const saveRes = await saveWorkflowState(
            orgId,
            workflowName,
            nodes,
            edges,
            workflowDescription,
          );
          if (!saveRes.success) {
            toast.error(saveRes.error || 'Failed to save workflow before publishing.');
            return;
          }
          if (!saveRes.workflowId) {
            toast.error('Failed to save workflow before publishing.');
            return;
          }
          targetWfId = saveRes.workflowId;
        } else if (hasUnsavedChanges) {
          const updateRes = await updateWorkflowState(
            orgId,
            targetWfId,
            nodes,
            edges,
            { name: workflowName, description: workflowDescription },
          );
          if (!updateRes.success) {
            toast.error(updateRes.error || 'Failed to save workflow before publishing.');
            return;
          }
          setDraftRevision((r) => r + 1);
          setSavedBaseline(
            JSON.stringify({
              name: workflowName,
              description: workflowDescription,
              nodes,
              edges,
            }),
          );
        }

        const result = await publishWorkflowAction(orgId, targetWfId);
        if (result.success) {
          setPublishedVersionNumber(result.versionNumber);
          setIsActive(true);
          toast.success(`Published v${result.versionNumber} successfully.`);
          if (!workflowId && targetWfId) {
            router.push(`/org/${orgId}/workflows/${targetWfId}`);
          }
        } else {
          toast.error(result.error || 'Failed to publish workflow.');
        }
      } catch {
        toast.error('Network error while publishing workflow.');
      } finally {
        setIsPublishing(false);
      }
    });
  };

  const handleToggleActive = (nextActive: boolean) => {
    if (!workflowId || isTogglingActive) return;
    setIsTogglingActive(true);
    startTransition(async () => {
      try {
        const result = await toggleWorkflowActiveAction(orgId, workflowId, nextActive);
        if (result.success) {
          setIsActive(result.isActive);
          toast.success(result.isActive ? 'Workflow activated.' : 'Workflow paused.');
        } else {
          toast.error(result.error || 'Failed to update workflow state.');
        }
      } catch {
        toast.error('Network error while updating workflow state.');
      } finally {
        setIsTogglingActive(false);
      }
    });
  };

  // ------------------------------------------------------------------
  // Simulation Visual Progress & Sequential Edge Flow Playback
  // ------------------------------------------------------------------
  const simulationTimersRef = useRef<NodeJS.Timeout[]>([]);

  const handleResetSimulationAnimation = useCallback(() => {
    simulationTimersRef.current.forEach(clearTimeout);
    simulationTimersRef.current = [];

    setEdges((eds) =>
      eds.map((e) => ({
        ...e,
        animated: false,
        className: '',
      })),
    );

    setNodes((nds) =>
      nds.map(
        (n) =>
          ({
            ...n,
            data: {
              ...n.data,
              executionStatus: undefined,
            },
          }) as AppNode,
      ),
    );
  }, [setEdges, setNodes]);

  const handleSimulationStart = useCallback(() => {
    simulationTimersRef.current.forEach(clearTimeout);
    simulationTimersRef.current = [];

    // All action nodes initially enter processing state
    setNodes((nds) =>
      nds.map((n) => {
        if (n.type === 'action') {
          return {
            ...n,
            data: {
              ...n.data,
              executionStatus: 'RUNNING' as unknown as undefined,
            },
          };
        }
        return n;
      }),
    );

    // Initial flow along all edges with clean white glow
    setEdges((eds) =>
      eds.map((e) => ({
        ...e,
        animated: true,
        className: 'simulating',
      })),
    );
  }, [setEdges, setNodes]);

  const handleSimulationComplete = useCallback(
    (simResult: WorkflowSimulationResult) => {
      simulationTimersRef.current.forEach(clearTimeout);
      simulationTimersRef.current = [];

      const steps = simResult.steps;
      if (steps.length === 0) {
        handleResetSimulationAnimation();
        return;
      }

      const stepMap = new Map(steps.map((s) => [s.stepId, s]));

      // 400ms interval between topological step arrivals for smooth visual flow
      const STEP_INTERVAL_MS = 400;

      steps.forEach((step, index) => {
        const timer = setTimeout(() => {
          // 1. Advance this step to its terminal state
          setNodes((nds) =>
            nds.map((n) => {
              if (n.id === step.stepId) {
                const status =
                  step.status === 'COMPLETED'
                    ? 'SUCCESS'
                    : step.status === 'SKIPPED'
                    ? 'SKIPPED'
                    : 'FAILED';
                return {
                  ...n,
                  data: {
                    ...n.data,
                    executionStatus: status as any,
                  },
                } as AppNode;
              }
              return n;
            }),
          );

          // 2. Animate edges: edges pointing to this node transition to completed,
          // and edges pointing from this node to downstream continue the flow
          setEdges((eds) =>
            eds.map((e) => {
              if (e.target === step.stepId) {
                return {
                  ...e,
                  animated: false,
                  className: step.status === 'COMPLETED' ? 'simulating-success' : '',
                };
              }
              if (e.source === step.stepId) {
                if (step.status === 'COMPLETED') {
                  return {
                    ...e,
                    animated: true,
                    className: 'simulating',
                  };
                } else {
                  return {
                    ...e,
                    animated: false,
                    className: '',
                  };
                }
              }
              return e;
            }),
          );

          // 3. Final step: settle all nodes and edges cleanly
          if (index === steps.length - 1) {
            setNodes((nds) =>
              nds.map((n) => {
                const stepResult = stepMap.get(n.id);
                if (stepResult) {
                  const status =
                    stepResult.status === 'COMPLETED'
                      ? 'SUCCESS'
                      : stepResult.status === 'SKIPPED'
                      ? 'SKIPPED'
                      : 'FAILED';
                  return {
                    ...n,
                    data: {
                      ...n.data,
                      executionStatus: status as any,
                    },
                  } as AppNode;
                }
                // Any unsimulated node on canvas: reset to idle so it NEVER remains stuck in RUNNING!
                if (n.type === 'action') {
                  return {
                    ...n,
                    data: {
                      ...n.data,
                      executionStatus: undefined,
                    },
                  } as AppNode;
                }
                return n;
              }),
            );

            setEdges((eds) =>
              eds.map((e) => ({
                ...e,
                animated: false,
                className: simResult.status === 'COMPLETED' ? 'simulating-success' : e.className,
              })),
            );
          }
        }, (index + 1) * STEP_INTERVAL_MS);

        simulationTimersRef.current.push(timer);
      });
    },
    [handleResetSimulationAnimation, setEdges, setNodes],
  );

  // Clear timers on unmount
  useEffect(() => {
    return () => {
      simulationTimersRef.current.forEach(clearTimeout);
    };
  }, []);

  return (
    <div className="flex flex-1 flex-col h-full min-w-0 relative overflow-hidden" ref={reactFlowWrapper}>
      {/* 1. Structured Two-Row Header */}
      <WorkflowEditorHeader
        workflowId={workflowId}
        orgId={orgId}
        name={workflowName}
        description={workflowDescription}
        isPending={isPending}
        canSave={nodes.length > 0}
        draftRevision={draftRevision}
        publishedVersionNumber={publishedVersionNumber}
        hasUnsavedChanges={hasUnsavedChanges}
        isActive={isActive}
        isPublishing={isPublishing}
        isTogglingActive={isTogglingActive}
        diagnostics={diagnostics}
        onFocusNode={(nodeId) => {
          setSelectedNodeId(nodeId);
          setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === nodeId })));
        }}
        onCommitName={handleCommitName}
        onCommitDescription={handleCommitDescription}
        onSave={handleSave}
        onPublish={handlePublish}
        onToggleActive={handleToggleActive}
        onOpenSimulation={() => {
          setSelectedNodeId(null);
          setIsSimulationOpen(true);
        }}
      />

      {/* 2. Main Workspace Layout: Canvas on left, Inspector / Simulator docked on right */}
      <div className="flex-1 flex flex-row min-h-0 relative overflow-hidden bg-[#07070a]">
        {/* Canvas Area */}
        <div className="flex-1 h-full min-w-0 relative">
          {/* Floating Contextual Canvas Toolbar */}
          <WorkflowCanvasToolbar
            isLocked={isCanvasLocked}
            onToggleLock={() => setIsCanvasLocked((v) => !v)}
          />

          {/* Empty Canvas Watermark */}
          {nodes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10 select-none">
              <div className="flex flex-col items-center gap-3 max-w-sm text-center p-6 rounded-2xl border border-white/[0.06] bg-[#0c0c14]/40 backdrop-blur-sm">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-white/[0.1] bg-white/[0.03] text-zinc-400">
                  <Workflow size={24} />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-mono font-semibold text-zinc-200">DAG Workspace Ready</p>
                  <p className="text-xs font-mono text-zinc-500 leading-relaxed">
                    Drag a Trigger blade from the floating toolbar to initiate your event-driven flow.
                  </p>
                </div>
              </div>
            </div>
          )}

          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onNodeClick={(_, node) => {
              setIsSimulationOpen(false);
              setSelectedNodeId(node.id);
              setNodes((nds) =>
                nds.map((n) => ({
                  ...n,
                  selected: n.id === node.id,
                })),
              );
            }}
            onPaneClick={() => {
              setSelectedNodeId(null);
              setNodes((nds) => nds.map((n) => ({ ...n, selected: false })));
            }}
            isValidConnection={isValidConnection}
            nodeTypes={nodeTypes}
            fitView
            panOnDrag={!isCanvasLocked}
            zoomOnScroll={!isCanvasLocked}
            colorMode="dark"
            defaultEdgeOptions={{
              type: 'smoothstep',
              style: { stroke: '#52525b', strokeWidth: 1.75 },
            }}
            connectionLineStyle={{
              stroke: '#e4e4e7',
              strokeWidth: 2,
              strokeDasharray: '5 4',
            }}
          >
            <Background gap={22} size={1.2} color="rgba(255, 255, 255, 0.05)" />
            <Controls className="!bg-[#0a0a10]/85 !border !border-white/[0.08] !rounded-xl overflow-hidden !shadow-xl [&>button]:!bg-transparent [&>button]:!border-white/[0.08] [&>button]:!text-zinc-300 hover:[&>button]:!text-white hover:[&>button]:!bg-white/[0.06]" />
            {/* Restrained aerospace minimap */}
            <MiniMap
              pannable
              zoomable
              bgColor="#08080c"
              maskColor="rgba(0, 0, 0, 0.75)"
              nodeColor={(node) => (node.type === 'trigger' ? '#f59e0b' : '#6366f1')}
              className="!w-36 !h-24 !bg-[#0a0a10]/85 !backdrop-blur-xl !border !border-white/[0.08] !rounded-xl !shadow-2xl opacity-60 hover:opacity-100 transition-opacity"
            />
          </ReactFlow>
        </div>

        {/* 3. Dedicated Right Panel: Simulation Console OR Contextual Inspector */}
        {isSimulationOpen && workflowId ? (
          <SimulationRightPanel
            isOpen={isSimulationOpen}
            onClose={() => {
              setIsSimulationOpen(false);
              handleResetSimulationAnimation();
            }}
            workflowId={workflowId}
            orgId={orgId}
            triggerEventId={nodes.find((n) => n.type === 'trigger')?.data.eventId}
            publishedVersionNumber={publishedVersionNumber}
            hasUnsavedChanges={hasUnsavedChanges}
            currentNodes={nodes}
            currentEdges={edges}
            onSimulationStart={handleSimulationStart}
            onSimulationComplete={handleSimulationComplete}
            onResetSimulation={handleResetSimulationAnimation}
          />
        ) : selectedNodeId ? (
          <PropertiesPanel
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            onClose={() => {
              setSelectedNodeId(null);
              setNodes((nds) => nds.map((n) => ({ ...n, selected: false })));
            }}
            onUpdateNodeData={handleUpdateNodeData}
            onDeleteNode={handleDeleteNode}
          />
        ) : null}
      </div>
    </div>
  );
}

export default function WorkflowBuilder(props: WorkflowCanvasProps) {
  return (
    <div className="flex h-full w-full overflow-hidden bg-[#07070a] relative">
      <ReactFlowProvider>
        <CanvasArea {...props} />
      </ReactFlowProvider>
    </div>
  );
}
