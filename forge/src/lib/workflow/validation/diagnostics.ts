// src/lib/workflow/validation/diagnostics.ts
//
// Canonical authoring-time & pre-publish workflow diagnostics (FC-014).
// Builds directly on `collectWorkflowDefinitionIssues` (workflow.ts),
// `validateActionNodeConfig` (registry.ts), and `getAvailableUpstreamOutputs`
// (utils.ts) — never a parallel graph validator.

import {
  collectWorkflowDefinitionIssues,
  type AppEdge,
  type AppNode,
  type WorkflowStep,
} from "@/lib/workflow-types/workflow";
import {
  AVAILABLE_ACTIONS,
  AVAILABLE_TRIGGERS,
  validateActionNodeConfig,
} from "@/lib/workflow-types/registry";
import { getAvailableUpstreamOutputs } from "@/lib/workflow/graph-ui/utils";

export type WorkflowDiagnosticSeverity = "ERROR" | "WARNING";

export type WorkflowDiagnosticCode =
  | "EMPTY_GRAPH"
  | "ID_MISMATCH"
  | "DUPLICATE_STEP_ID"
  | "UNKNOWN_DEPENDENCY"
  | "SELF_DEPENDENCY"
  | "UNKNOWN_ROUTING_CONDITION"
  | "CYCLE"
  | "NO_TRIGGER"
  | "MULTIPLE_TRIGGERS"
  | "UNCONFIGURED_TRIGGER"
  | "INVALID_TRIGGER"
  | "INVALID_ACTION"
  | "MISSING_REQUIRED_INPUT"
  | "INVALID_INPUT_TYPE"
  | "INVALID_VARIABLE_REFERENCE"
  | "UNSUPPORTED_SCHEMA"
  | "INDEPENDENT_COMPONENT";

export type WorkflowDiagnostic = {
  code: WorkflowDiagnosticCode;
  severity: WorkflowDiagnosticSeverity;
  message: string;
  nodeId?: string;
  edgeId?: string;
  path?: string[];
  suggestion?: string;
  blocksPublish: boolean;
};

export type WorkflowDiagnosticsReport = {
  issues: WorkflowDiagnostic[];
  errors: WorkflowDiagnostic[];
  warnings: WorkflowDiagnostic[];
  canPublish: boolean;
};

const KNOWN_TRIGGER_IDS = new Set(AVAILABLE_TRIGGERS.map((t) => t.id));
const KNOWN_ACTION_IDS = new Set(AVAILABLE_ACTIONS.map((a) => a.id));

/**
 * Evaluate a workflow graph (`AppNode[]`, `AppEdge[]`) for both authoring UI
 * diagnostics and authoritative server-side publish readiness.
 */
export function evaluateWorkflowDiagnostics(
  nodes: AppNode[],
  edges: AppEdge[],
  options?: {
    registeredActionIds?: ReadonlySet<string>;
  },
): WorkflowDiagnosticsReport {
  const issues: WorkflowDiagnostic[] = [];
  const validActionIds = options?.registeredActionIds ?? KNOWN_ACTION_IDS;

  // 1. Structural DAG checks via canonical `collectWorkflowDefinitionIssues`
  const steps: Record<string, WorkflowStep> = {};
  const nodeIds = new Set(nodes.map((n) => n.id));
  const seenIds = new Set<string>();

  for (const node of nodes) {
    if (seenIds.has(node.id)) {
      issues.push({
        code: "DUPLICATE_STEP_ID",
        severity: "ERROR",
        nodeId: node.id,
        message: `Duplicate node ID "${node.id}" found in graph.`,
        suggestion: "Remove or recreate the duplicate node.",
        blocksPublish: true,
      });
      continue;
    }
    seenIds.add(node.id);

    const dependsOn = [
      ...new Set(
        edges.filter((edge) => edge.target === node.id).map((edge) => edge.source),
      ),
    ];

    const action =
      node.type === "trigger"
        ? node.data.eventId || "unknown_trigger"
        : node.data.actionType || "unknown_action";

    steps[node.id] = {
      id: node.id,
      action,
      dependsOn,
      config: node.type === "action" ? node.data.config || {} : {},
      isCritical: node.type === "action" ? Boolean(node.data.isCritical) : false,
      kind: node.type === "trigger" ? "TRIGGER" : "ACTION",
    };
  }

  // Flag edges pointing to missing nodes
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      issues.push({
        code: "UNKNOWN_DEPENDENCY",
        severity: "ERROR",
        edgeId: edge.id,
        nodeId: nodeIds.has(edge.target) ? edge.target : undefined,
        message: `Edge "${edge.id}" references a missing node.`,
        suggestion: "Remove the dangling connection.",
        blocksPublish: true,
      });
    }
  }

  const structuralIssues = collectWorkflowDefinitionIssues({ steps });
  for (const issue of structuralIssues) {
    issues.push({
      code: issue.code,
      severity: "ERROR",
      message: issue.message,
      nodeId: issue.stepId,
      path: issue.path,
      suggestion:
        issue.code === "CYCLE"
          ? "Remove one of the connecting edges to break the cycle."
          : issue.code === "EMPTY_GRAPH"
          ? "Add a Trigger node and at least one Action node."
          : undefined,
      blocksPublish: true,
    });
  }

  if (nodes.length === 0) {
    return buildReport(issues);
  }

  // 2. Trigger cardinality & configuration
  const triggerNodes = nodes.filter((n) => n.type === "trigger");
  if (triggerNodes.length === 0) {
    issues.push({
      code: "NO_TRIGGER",
      severity: "ERROR",
      message: "Workflow has no Trigger node. A configured trigger is required to publish.",
      suggestion: "Drag a Trigger node onto the canvas and select an event.",
      blocksPublish: true,
    });
  } else if (triggerNodes.length > 1) {
    for (const trig of triggerNodes.slice(1)) {
      issues.push({
        code: "MULTIPLE_TRIGGERS",
        severity: "ERROR",
        nodeId: trig.id,
        message: "Workflow contains multiple Trigger nodes. Only one trigger is allowed to publish.",
        suggestion: "Remove extra Trigger nodes so exactly one remains.",
        blocksPublish: true,
      });
    }
  }

  for (const trig of triggerNodes) {
    const eventId = trig.data.eventId;
    if (!eventId) {
      issues.push({
        code: "UNCONFIGURED_TRIGGER",
        severity: "ERROR",
        nodeId: trig.id,
        message: "Trigger node has no event selected.",
        suggestion: "Select an Event Type in the Trigger configuration panel.",
        blocksPublish: true,
      });
    } else if (!KNOWN_TRIGGER_IDS.has(eventId)) {
      issues.push({
        code: "INVALID_TRIGGER",
        severity: "ERROR",
        nodeId: trig.id,
        message: `Trigger event "${eventId}" is not a recognized trigger.`,
        suggestion: "Choose a supported trigger event.",
        blocksPublish: true,
      });
    }
  }

  // 3. Action registration, required inputs & variable reference validation
  const actionNodes = nodes.filter((n) => n.type === "action");
  for (const act of actionNodes) {
    const actionType = act.data.actionType;
    if (!actionType || actionType === "unset" || !validActionIds.has(actionType)) {
      issues.push({
        code: "INVALID_ACTION",
        severity: "ERROR",
        nodeId: act.id,
        message:
          !actionType || actionType === "unset"
            ? `Action node "${act.data.label || act.id}" has no action selected.`
            : `Action "${actionType}" is not registered for execution.`,
        suggestion: "Select a registered Action Type in the configuration panel.",
        blocksPublish: true,
      });
      continue;
    }

    const upstream = getAvailableUpstreamOutputs(act.id, nodes, edges);
    const configIssues = validateActionNodeConfig(actionType, act.data.config, upstream);
    for (const ci of configIssues) {
      issues.push({
        code: ci.code,
        severity: "ERROR",
        nodeId: act.id,
        message: ci.message,
        suggestion:
          ci.code === "MISSING_REQUIRED_INPUT"
            ? "Provide a value or connect an upstream node and map the variable."
            : ci.code === "INVALID_VARIABLE_REFERENCE"
            ? "Use {{stepId.outputs.field}} or {{trigger.outputs.field}} from a connected upstream node."
            : "Check the field value against the schema constraints.",
        blocksPublish: true,
      });
    }
  }

  // 4. Independent roots / unreachable-from-trigger warnings (non-blocking for structural DAG)
  if (triggerNodes.length > 0 && actionNodes.length > 0) {
    const reachable = new Set<string>();
    const queue = triggerNodes.map((t) => t.id);
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (reachable.has(current)) continue;
      reachable.add(current);
      for (const edge of edges) {
        if (edge.source === current && !reachable.has(edge.target)) {
          queue.push(edge.target);
        }
      }
    }

    for (const act of actionNodes) {
      if (!reachable.has(act.id)) {
        issues.push({
          code: "INDEPENDENT_COMPONENT",
          severity: "WARNING",
          nodeId: act.id,
          message: `Node "${act.data.label || act.id}" is not connected to a trigger and will execute as an independent root.`,
          suggestion: "Connect an edge from a trigger or upstream action if it should wait for trigger data.",
          blocksPublish: false,
        });
      }
    }
  }

  return buildReport(issues);
}

function buildReport(issues: WorkflowDiagnostic[]): WorkflowDiagnosticsReport {
  const errors = issues.filter((i) => i.severity === "ERROR");
  const warnings = issues.filter((i) => i.severity === "WARNING");
  return {
    issues,
    errors,
    warnings,
    canPublish: !issues.some((i) => i.blocksPublish),
  };
}
