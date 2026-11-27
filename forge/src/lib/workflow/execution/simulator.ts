import type { JsonValue } from "@/lib/workflow-types/type";
import type { WorkflowDefinition, WorkflowStep } from "@/lib/workflow-types/workflow";
import { resolveInputs } from "@/lib/workflow/execution/resolver";
import { executeConditionNode } from "@/lib/workflow/actions/logic/conditions";

export const MAX_SIMULATION_STEPS = 50;
export const MAX_SIMULATION_OUTPUT_CHARS = 4096;

const SENSITIVE_KEY_PATTERN =
  /^(password|passwd|secret|token|apikey|api_key|authorization|auth|cookie|credential|private_key|privatekey|access_token|refresh_token)$/i;

export type SimulatedStepStatus = "COMPLETED" | "FAILED" | "SKIPPED";

export interface SimulatedStepResult {
  stepId: string;
  label: string;
  kind: "TRIGGER" | "ACTION";
  action: string;
  status: SimulatedStepStatus;
  durationMs: number;
  resolvedInputs: Record<string, JsonValue>;
  outputs: Record<string, JsonValue> | null;
  error?: string;
  skipReason?: string;
  truncated?: boolean;
}

export interface WorkflowSimulationResult {
  simulated: true;
  status: "COMPLETED" | "FAILED";
  totalDurationMs: number;
  triggerOutputs: Record<string, JsonValue>;
  steps: SimulatedStepResult[];
}

type SimulationAdapter = (
  resolvedInputs: Record<string, JsonValue>,
  step: WorkflowStep,
) => Promise<Record<string, JsonValue>>;

const SIMULATION_ADAPTERS: Record<string, SimulationAdapter> = {
  "task.create": async (inputs, step) => {
    const title =
      typeof inputs.title === "string" ? inputs.title.trim() : "";
    const projectId =
      typeof inputs.projectId === "string" ? inputs.projectId.trim() : "";

    if (!projectId) {
      throw new Error('Missing required input "projectId" for task.create.');
    }
    if (!title) {
      throw new Error('Missing required input "title" for task.create.');
    }

    return {
      taskId: `sim_task_${step.id}`,
      projectId,
      title,
      priority:
        typeof inputs.priority === "string" && inputs.priority.trim()
          ? inputs.priority.trim()
          : "MEDIUM",
      simulated: true,
    };
  },
  "logic.condition": async (inputs) => {
    const out = await executeConditionNode(inputs);
    const branch = out.data?.branch === "TRUE" ? "TRUE" : "FALSE";
    return {
      result: branch === "TRUE",
      branch,
      details: out.data?.details ?? "",
    };
  },
  "logic.delay": async (inputs) => {
    const ms =
      typeof inputs.durationMs === "number" && Number.isFinite(inputs.durationMs)
        ? Math.max(0, inputs.durationMs)
        : 0;
    return {
      delayedMs: ms,
      simulated: true,
    };
  },
};

/**
 * Redacts sensitive keys recursively so simulation previews never leak tokens or secrets.
 */
export function redactSimulationValue(value: JsonValue, depth = 0): JsonValue {
  if (depth > 8) return "[Truncated depth]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactSimulationValue(item, depth + 1));
  }
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(k)) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = redactSimulationValue(v, depth + 1);
    }
  }
  return out;
}

function truncateRecordIfNeeded(
  record: Record<string, JsonValue>,
): { value: Record<string, JsonValue>; truncated: boolean } {
  const redacted = redactSimulationValue(record) as Record<string, JsonValue>;
  const serialized = JSON.stringify(redacted);
  if (serialized.length <= MAX_SIMULATION_OUTPUT_CHARS) {
    return { value: redacted, truncated: false };
  }
  return {
    value: {
      _truncated: true,
      _originalLength: serialized.length,
      preview: serialized.slice(0, MAX_SIMULATION_OUTPUT_CHARS),
    },
    truncated: true,
  };
}

function topologicalOrder(steps: Record<string, WorkflowStep>): string[] {
  const ids = Object.keys(steps);
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const id of ids) {
    inDegree.set(id, 0);
    dependents.set(id, []);
  }

  for (const id of ids) {
    const deps = steps[id]?.dependsOn ?? [];
    for (const dep of deps) {
      if (!steps[dep]) continue;
      inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
      dependents.get(dep)?.push(id);
    }
  }

  const queue: string[] = ids.filter((id) => (inDegree.get(id) ?? 0) === 0);
  const order: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);
    for (const next of dependents.get(current) ?? []) {
      const nextDegree = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, nextDegree);
      if (nextDegree === 0) {
        queue.push(next);
      }
    }
  }

  if (order.length !== ids.length) {
    throw new Error("Workflow graph contains a cycle or unreachable dependency.");
  }

  return order;
}

export async function simulateWorkflowRun(
  definition: WorkflowDefinition,
  triggerPayload: Record<string, JsonValue>,
  options?: { labelMap?: Record<string, string> },
): Promise<WorkflowSimulationResult> {
  const startedAt = Date.now();
  const stepEntries = Object.entries(definition.steps ?? {});
  if (stepEntries.length === 0) {
    throw new Error("Workflow has no steps to simulate.");
  }
  if (stepEntries.length > MAX_SIMULATION_STEPS) {
    throw new Error(
      `Workflow exceeds maximum simulation limit of ${MAX_SIMULATION_STEPS} steps.`,
    );
  }

  const order = topologicalOrder(definition.steps);
  const safeTrigger = truncateRecordIfNeeded(triggerPayload).value;
  const context: Record<string, JsonValue> = {
    trigger: { outputs: safeTrigger },
  };

  const stepStatus = new Map<string, SimulatedStepStatus>();
  const stepOutputs = new Map<string, Record<string, JsonValue>>();
  const results: SimulatedStepResult[] = [];
  let hasFailure = false;

  for (const stepId of order) {
    const step = definition.steps[stepId];
    const stepStart = Date.now();
    const label = options?.labelMap?.[stepId] ?? stepId;

    if (step.kind === "TRIGGER") {
      const { value: out, truncated } = truncateRecordIfNeeded(triggerPayload);
      context[stepId] = { outputs: out };
      stepStatus.set(stepId, "COMPLETED");
      stepOutputs.set(stepId, out);
      results.push({
        stepId,
        label,
        kind: "TRIGGER",
        action: step.action,
        status: "COMPLETED",
        durationMs: Math.max(0, Date.now() - stepStart),
        resolvedInputs: {},
        outputs: out,
        truncated,
      });
      continue;
    }

    // Check dependency statuses and branch routingConditions
    let skipReason: string | undefined;
    for (const depId of step.dependsOn) {
      const depStatus = stepStatus.get(depId);
      if (depStatus === "FAILED" || depStatus === "SKIPPED") {
        skipReason = `Skipped because upstream step "${depId}" ${depStatus.toLowerCase()}.`;
        break;
      }

      const expectedCondition = step.routingConditions?.[depId];
      if (expectedCondition !== undefined) {
        const depOut = stepOutputs.get(depId);
        const actualBranch =
          depOut && typeof depOut.branch === "string"
            ? depOut.branch
            : depOut && depOut.result !== undefined
            ? String(depOut.result)
            : undefined;
        if (
          !actualBranch ||
          actualBranch.toUpperCase() !== expectedCondition.toUpperCase()
        ) {
          skipReason = `Branch condition "${expectedCondition}" on "${depId}" not met (actual: "${actualBranch ?? "none"}").`;
          break;
        }
      }
    }

    if (skipReason) {
      stepStatus.set(stepId, "SKIPPED");
      results.push({
        stepId,
        label,
        kind: "ACTION",
        action: step.action,
        status: "SKIPPED",
        durationMs: 0,
        resolvedInputs: {},
        outputs: null,
        skipReason,
      });
      continue;
    }

    const configured = (step.config ?? {}) as Record<string, JsonValue>;
    const resolved = resolveInputs(configured, context);

    // Sandbox helper: if title or projectId can be inferred from context or label, populate for smooth simulation
    const triggerContext = context.trigger as { outputs?: Record<string, JsonValue> } | undefined;
    if (!resolved.projectId && typeof triggerContext?.outputs?.projectId === "string") {
      resolved.projectId = triggerContext.outputs.projectId;
    }
    if (!resolved.title) {
      if (typeof configured.title === "string" && configured.title.trim()) {
        resolved.title = configured.title.trim();
      } else if (label && label !== stepId) {
        resolved.title = label;
      }
    }

    const { value: redactedInputs } = truncateRecordIfNeeded(resolved);

    const adapter = SIMULATION_ADAPTERS[step.action];
    if (!adapter) {
      hasFailure = true;
      const errMsg = `Action "${step.action}" is not supported in sandbox simulation (no external side effects executed).`;
      stepStatus.set(stepId, "FAILED");
      results.push({
        stepId,
        label,
        kind: "ACTION",
        action: step.action,
        status: "FAILED",
        durationMs: Math.max(0, Date.now() - stepStart),
        resolvedInputs: redactedInputs,
        outputs: null,
        error: errMsg,
      });
      continue;
    }

    try {
      const rawOut = await adapter(resolved, step);
      const { value: out, truncated } = truncateRecordIfNeeded(rawOut);
      context[stepId] = { outputs: out };
      stepStatus.set(stepId, "COMPLETED");
      stepOutputs.set(stepId, out);
      results.push({
        stepId,
        label,
        kind: "ACTION",
        action: step.action,
        status: "COMPLETED",
        durationMs: Math.max(0, Date.now() - stepStart),
        resolvedInputs: redactedInputs,
        outputs: out,
        truncated,
      });
    } catch (err) {
      hasFailure = true;
      const errMsg =
        err instanceof Error ? err.message : "Simulated action execution failed.";
      stepStatus.set(stepId, "FAILED");
      results.push({
        stepId,
        label,
        kind: "ACTION",
        action: step.action,
        status: "FAILED",
        durationMs: Math.max(0, Date.now() - stepStart),
        resolvedInputs: redactedInputs,
        outputs: null,
        error: errMsg,
      });
    }
  }

  return {
    simulated: true,
    status: hasFailure ? "FAILED" : "COMPLETED",
    totalDurationMs: Math.max(0, Date.now() - startedAt),
    triggerOutputs: safeTrigger,
    steps: results,
  };
}
