import { AppNode, AppEdge, WorkflowDefinition, WorkflowStep } from "@/lib/workflow-types/workflow";
// UI SIDE COMPILER
// This function takes the raw nodes and edges from the React Flow editor and transforms them into a structured WorkflowDefinition that our Orchestrator Engine can execute.
// It identifies the dependencies between steps based on the edges, and extracts the necessary configuration for each action.
export function compileWorkflow(nodes: AppNode[], edges: AppEdge[]): WorkflowDefinition {
  const steps: Record<string, WorkflowStep> = {};
    
  nodes.forEach((node) => {
    // Find all edges that point TO this node
    const incomingEdges = edges.filter((e) => e.target === node.id);
    
    // Map those edges to get the IDs of the parent nodes
    const dependsOn = incomingEdges.map((e) => e.source);

    // Extract the action type (or 'trigger' if it's the entry point)
    let action = 'unknown';
    let config = {};
    let isCritical = false; // FIX THESE LATER: We need to pull this from the node data in the React Flow editor, but for now we'll default to false.

    if (node.type === 'trigger') {
      action = node.data.eventId || 'unknown_trigger';
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
    };
  });

  return {
    id: "compiled_" + Date.now(), // Or a uuid
    name: "Compiled Execution Graph",
    steps,
  };
}