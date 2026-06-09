import { AppNode, AppEdge, WorkflowDefinition, WorkflowStep } from "@/lib/workflow-types/workflow";

// It identifies the dependencies between steps based on the edges, and extracts the necessary configuration for each action.
export function compileWorkflow(nodes: AppNode[], edges: AppEdge[]): WorkflowDefinition {
  const steps: Record<string, WorkflowStep> = {};
    
  nodes.forEach((node) => {
    
    const incomingEdges = edges.filter((e) => e.target === node.id);
    const dependsOn = incomingEdges.map((e) => e.source);

    let action = 'unknown';
    let config = {};

    let isCritical = false; // FIX THESE LATER: We need to pull this from the node data in the React Flow editor, but for now we'll default to false.
    
    let kind: 'TRIGGER' | 'ACTION' = 'ACTION'; // Default to ACTION, but we'll set this properly based on the node type
    if (node.type === 'trigger') {
      action = node.data.eventId || 'unknown_trigger';
      kind = 'TRIGGER';
    } else if (node.type === 'action') {
      action = node.data.actionType || 'unknown_action';
      config = node.data.config || {};
      isCritical = node.data.isCritical || false;
    }

    steps[node.id] = {
      id: node.id,
      action,
      dependsOn,
      config,
      isCritical,
      kind,
    };
  });

  return {
    id: "compiled_" + Date.now(), // Or a uuid
    name: "Compiled Execution Graph",
    steps,
  };
}