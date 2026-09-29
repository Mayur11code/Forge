import {
  WorkflowValidationError,
  collectWorkflowDefinitionIssues,
  type WorkflowDefinition,
  type WorkflowStep,
  type AppNode,
  type AppEdge,
} from "@/lib/workflow-types/workflow";

/**
 * Compile a canvas into the execution graph the evaluator runs.
 *
 * Throws `WorkflowValidationError` when the canvas describes something that
 * cannot execute. Validating here rather than in the two save actions is
 * deliberate: this is the only function that turns user-drawn edges into
 * `dependsOn`, so it is the only place a cycle or a dangling edge can be
 * meaningfully caught. Validation at the call site would be one `if` away from
 * being forgotten on the next call site, and an invalid graph that reaches the
 * database produces a run that hangs with no error rather than a save that
 * fails.
 */
export function compileWorkflow(
  nodes: AppNode[],
  edges: AppEdge[],
): WorkflowDefinition {
  const steps: Record<string, WorkflowStep> = {};

  for (const node of nodes) {
    // Deduplicated because a canvas can easily contain two edges between the
    // same pair of nodes - a duplicated dependency makes the step appear to have
    // more parents than it does, which is invisible but wrong.
    const dependsOn = [
      ...new Set(edges.filter((edge) => edge.target === node.id).map((edge) => edge.source)),
    ];

    let action = "unknown";
    let config: Record<string, unknown> = {};
    let isCritical = false;
    let kind: "TRIGGER" | "ACTION" = "ACTION";

    if (node.type === "trigger") {
      action = node.data.eventId || "unknown_trigger";
      kind = "TRIGGER";
    } else if (node.type === "action") {
      action = node.data.actionType || "unknown_action";
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
  }

  const definition: WorkflowDefinition = {
    id: `compiled_${Date.now()}`,
    name: "Compiled Execution Graph",
    steps,
  };

  const issues = collectWorkflowDefinitionIssues(definition);
  if (issues.length > 0) {
    throw new WorkflowValidationError(issues);
  }

  return definition;
}
