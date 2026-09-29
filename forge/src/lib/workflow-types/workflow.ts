//server boundary

import { z } from 'zod';
import type { Node, Edge } from '@xyflow/react';
import { StepExecutionStatus } from '@prisma/client';

const ExecutionStatusSchema = z
  .enum(StepExecutionStatus)
  .optional();


export const WorkflowStepSchema = z.object({
  id: z.string(),
  action: z.string(), 
  dependsOn: z.array(z.string()), 
  // Tells the engine which branch this node sits on
  routingConditions: z.record(z.string(), z.string()).optional(),
  isCritical: z.boolean().optional().default(false), 

  kind: z.enum([
     "TRIGGER",
     "ACTION",
   ]),

  
  config: z.record(z.string(), z.any()).optional().default({}), 
});

// ---------------------------------------------------------------------------
// SEMANTIC GRAPH VALIDATION
// ---------------------------------------------------------------------------
//
// The shape schemas above cannot express any of this, and the gap is not
// theoretical. `steps` is a record and `dependsOn` is a string array, so a
// dependency on a step that does not exist, a step that depends on itself, or a
// canvas with a cycle in it all validate perfectly. Each of them then produces a
// run that hangs rather than one that fails: the evaluator finds no step whose
// dependencies are all satisfied, dispatches nothing, and every subsequent pass
// reaches the same conclusion. A user connecting two arrows the wrong way gets
// a workflow that sits RUNNING forever with no error anywhere.
//
// The checks are therefore part of the schema, not a separate opt-in call, so
// that a definition cannot be written to the database without them. "Validate on
// save" as a step someone can forget is not validation.

export type WorkflowDefinitionIssueCode =
  | "EMPTY_GRAPH"
  | "ID_MISMATCH"
  | "DUPLICATE_STEP_ID"
  | "UNKNOWN_DEPENDENCY"
  | "SELF_DEPENDENCY"
  | "UNKNOWN_ROUTING_CONDITION"
  | "CYCLE";

export type WorkflowDefinitionIssue = {
  code: WorkflowDefinitionIssueCode;
  message: string;
  stepId?: string;
  /** The dependency chain that closes a cycle, first and last node identical. */
  path?: string[];
};

/**
 * Find a cycle by iterative depth-first search.
 *
 * Iterative rather than recursive on purpose: this graph arrives from a user
 * dragging nodes onto a canvas, and a pasted or generated graph can be deep
 * enough to overflow the call stack. A stack overflow inside a Zod refinement
 * surfaces as an opaque `RangeError` from inside a validator, which is a
 * miserable thing to debug and gives the user no indication that their graph is
 * the problem.
 */
function findDependencyCycle(
  steps: Record<string, { dependsOn: string[] }>,
): string[] | null {
  const GREY = 1;
  const BLACK = 2;

  const colour = new Map<string, number>();
  for (const key of Object.keys(steps)) {
    colour.set(key, 0);
  }

  for (const root of Object.keys(steps)) {
    if (colour.get(root) !== 0) continue;

    const path: string[] = [root];
    const frames: Array<{ id: string; next: number }> = [{ id: root, next: 0 }];
    colour.set(root, GREY);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const dependencies = steps[frame.id]?.dependsOn ?? [];

      if (frame.next < dependencies.length) {
        const dependency = dependencies[frame.next++];
        const state = colour.get(dependency) ?? 0;

        if (state === GREY) {
          // Reached a node still on the current path: everything from that node
          // onwards is the cycle. Reported in full so the UI can name the arrows
          // the user has to delete, rather than just saying "there is a cycle".
          const start = path.indexOf(dependency);
          return [...path.slice(start), dependency];
        }

        if (state === 0) {
          colour.set(dependency, GREY);
          path.push(dependency);
          frames.push({ id: dependency, next: 0 });
        }

        continue;
      }

      colour.set(frame.id, BLACK);
      frames.pop();
      path.pop();
    }
  }

  return null;
}

export function collectWorkflowDefinitionIssues(
  definition: { steps: Record<string, z.infer<typeof WorkflowStepSchema>> },
): WorkflowDefinitionIssue[] {
  const issues: WorkflowDefinitionIssue[] = [];
  const steps = definition.steps;
  const stepIds = Object.keys(steps);

  if (stepIds.length === 0) {
    issues.push({
      code: "EMPTY_GRAPH",
      message: "A workflow needs at least one step.",
    });
    return issues;
  }

  const known = new Set(stepIds);

  // `steps` is a record keyed by step id, but each step also carries an `id`.
  // The engine reads the KEY and the compiler writes both, so a divergence is
  // silent: the graph appears to have step `a`, `WorkflowStep.id` claims it is
  // `b`, and anything that trusts the inner id resolves to nothing.
  const seenInnerIds = new Map<string, string>();

  for (const [key, step] of Object.entries(steps)) {
    if (step.id !== key) {
      issues.push({
        code: "ID_MISMATCH",
        stepId: key,
        message: `Step "${key}" declares id "${step.id}". These must match.`,
      });
    }

    const previousKey = seenInnerIds.get(step.id);
    if (previousKey !== undefined) {
      issues.push({
        code: "DUPLICATE_STEP_ID",
        stepId: key,
        message: `Step id "${step.id}" is used by both "${previousKey}" and "${key}".`,
      });
    } else {
      seenInnerIds.set(step.id, key);
    }

    for (const dependency of step.dependsOn) {
      if (dependency === key) {
        issues.push({
          code: "SELF_DEPENDENCY",
          stepId: key,
          message: `Step "${key}" depends on itself.`,
        });
        continue;
      }

      if (!known.has(dependency)) {
        issues.push({
          code: "UNKNOWN_DEPENDENCY",
          stepId: key,
          message: `Step "${key}" depends on "${dependency}", which is not a step in this workflow.`,
        });
      }
    }

    // A routing condition on a non-dependency can never be evaluated, because
    // the engine only reads routing conditions for steps it is already waiting
    // on. The branch would silently behave as an unconditional one.
    for (const conditionOn of Object.keys(step.routingConditions ?? {})) {
      if (!step.dependsOn.includes(conditionOn)) {
        issues.push({
          code: "UNKNOWN_ROUTING_CONDITION",
          stepId: key,
          message: `Step "${key}" has a routing condition on "${conditionOn}", which it does not depend on.`,
        });
      }
    }
  }

  const cycle = findDependencyCycle(steps);
  if (cycle) {
    issues.push({
      code: "CYCLE",
      message: `Steps form a cycle: ${cycle.join(" -> ")}. A workflow must be a directed acyclic graph.`,
      path: cycle,
    });
  }

  return issues;
}

/**
 * Raised when a graph cannot be materialised.
 *
 * A distinct class so callers can tell "the user drew an invalid workflow" from
 * "the database is down" and report the first accurately. Collapsing both into a
 * generic save failure is how an invalid canvas ends up described to the user as
 * a server error.
 */
export class WorkflowValidationError extends Error {
  readonly issues: WorkflowDefinitionIssue[];

  constructor(issues: WorkflowDefinitionIssue[]) {
    super(
      issues.length === 1
        ? issues[0].message
        : `Workflow has ${issues.length} problems: ${issues
            .map((issue) => issue.message)
            .join(" ")}`,
    );
    this.name = "WorkflowValidationError";
    this.issues = issues;
  }
}

export const WorkflowDefinitionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    steps: z.record(z.string(), WorkflowStepSchema),
  })
  .superRefine((definition, ctx) => {
    for (const issue of collectWorkflowDefinitionIssues(definition)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: issue.message,
        path: issue.stepId ? ["steps", issue.stepId] : ["steps"],
      });
    }
  });

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;


//frontend ui payloads
export const TriggerNodeDataSchema = z.object({
  label: z.string(),
  eventId: z.string().nullable(), 
  executionStatus: ExecutionStatusSchema, // This will be injected live during execution to reflect the current status of the step
});

export const ActionNodeDataSchema = z.object({
  label: z.string(),
  actionType: z.string(), 
  config: z.record(z.string(), z.any()).default({}),
  isConfigured: z.boolean().default(false),
  isCritical: z.boolean().default(false),

  executionStatus: ExecutionStatusSchema, // This will be injected live during execution to reflect the current status of the step
});

export type TriggerNodeData = z.infer<typeof TriggerNodeDataSchema>;
export type ActionNodeData = z.infer<typeof ActionNodeDataSchema>;


export type TriggerNodeType = Node<TriggerNodeData, 'trigger'>;
export type ActionNodeType = Node<ActionNodeData, 'action'>;

export type AppNode = TriggerNodeType | ActionNodeType;
export type AppEdge = Edge;

export interface WorkflowCanvasState {
  nodes: AppNode[];
  edges: AppEdge[];
}


// to be used when passing full database rows into components
export interface TypedWorkflow {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  
  // The React Flow UI layout
  uiNodes: AppNode[];
  uiEdges: AppEdge[];
  
  // The deeply validated Zod-backed Execution Graph
  definition: WorkflowDefinition; 
  
  orgId: string;
  eventId: string | null;
  
  createdAt: Date;
  updatedAt: Date;
}