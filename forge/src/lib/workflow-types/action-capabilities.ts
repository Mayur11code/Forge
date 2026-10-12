// src/lib/workflow-types/action-capabilities.ts
//
// THE PLANNER-FACING ACTION CAPABILITY CATALOG.
//
// One machine-readable description per action: what it accepts, what it
// produces, and what it costs to fail. This is what a model reads when it
// decides whether a generated workflow step is valid, and what the canvas reads
// when it decides which fields to show and which outputs can be wired.
//
// Client-safe by construction. It imports `zod` and nothing else at runtime:
//
//   - no Prisma client, no database module
//   - no server-only action implementation (the modules under
//     src/lib/workflow/actions/** import the extended Prisma client and must
//     never reach a browser bundle)
//   - no runtime import of ./action-registry either, because that module
//     transitively imports an action implementation. The coupling to the
//     registry is a TYPE-ONLY import, which `isolatedModules` erases, so the
//     key set is still checked at compile time with no runtime edge.
//
// A capability here is SCHEMA INFORMATION ONLY. It is never execution
// authority. `orgId`, `userId`, `workflowId` and `runId` are deliberately absent
// from every input schema: they come from trusted persisted context (the
// AgentSession row for tools, the Workflow row for actions) and a capability
// must never advertise a way to supply them. See AD-10 and AD-P1 in
// docs/architecture/workflows/assignments-37-tracker.md.
//
// The runtime registry (./action-registry.ts) remains the only thing that can
// decide an action runs. This file describes; it does not dispatch.

import { z } from "zod";
import type { RegisteredActionId } from "./action-registry";

/**
 * Everything a planner needs to emit a valid step, and nothing a planner is
 * allowed to influence.
 */
export type ActionCapability = {
  /** Must equal a key of the runtime registry. Enforced by `satisfies` below. */
  id: string;
  /** Short human label. Used by the canvas picker and by the prompt. */
  label: string;
  /** What the action does, in terms a model can act on. */
  description: string;
  /**
   * STRICT object schema for model-supplied inputs. `.strict()`, so an unknown
   * key is rejected instead of silently dropped — a typo in a field name must
   * fail at the generation boundary, not at execution time.
   */
  input: z.ZodType;
  /**
   * Object schema for the SUCCESSFUL business payload only — the value an
   * action returns under ActionResult.data, which is what the wrapper persists
   * into StepRun.outputs and what `{{stepId.outputs.*}}` resolves against.
   * Not the outer ActionResult envelope.
   */
  output: z.ZodType;
  /**
   * Whether the action defines a compensation function. Drives the saga path in
   * the executor; a planner does not choose it.
   */
  compensation: { available: boolean };
  /**
   * Documented failure behaviour, for the planner and for 37.14. Descriptive,
   * not authoritative — the executor still decides per attempt.
   */
  failure: {
    /** What the runtime currently does on failure, or null when undecided. */
    isRetriableByDefault: boolean | null;
    notes: string;
  };
};

/**
 * Narrow a capability schema to a Zod object.
 *
 * Throwing rather than returning an empty list is deliberate. Every derivation
 * below answers "which fields does this action expose?", and a schema shape that
 * cannot be read would make that answer silently empty — which is exactly the
 * defect this module exists to fix. An unreadable schema is a bug in the
 * capability, and it should say so.
 */
function objectShape(schema: z.ZodType, context: string): Record<string, z.ZodType> {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error(
      `${context} must be a z.object(...) so its fields can be derived. ` +
        `A hand-maintained field list is the failure mode this module prevents.`,
    );
  }
  return schema.shape as Record<string, z.ZodType>;
}

/**
 * Every model-suppliable input, in declaration order.
 *
 * The UI builds its form from this rather than from its own field list, so a new
 * argument on the input schema appears in the canvas without a second edit.
 */
export function inputFields(input: z.ZodType): {
  name: string;
  field: z.ZodType;
}[] {
  return Object.entries(objectShape(input, "Capability input schema")).map(
    ([name, field]) => ({ name, field }),
  );
}

/**
 * Inputs the model must supply.
 *
 * Derived from optionality on the schema, not from a parallel array, so adding
 * a required argument to an input schema cannot leave the UI and the prompt
 * still advertising the old set.
 */
export function requiredInputFields(input: z.ZodType): string[] {
  return Object.entries(objectShape(input, "Capability input schema"))
    .filter(([, field]) => !field.isOptional())
    .map(([name]) => name);
}

/**
 * Inputs the model may omit. Includes fields with a `.default()`, because a
 * defaulted field is optional from the caller's side even though it is always
 * present after parsing.
 */
export function optionalInputFields(input: z.ZodType): string[] {
  return Object.entries(objectShape(input, "Capability input schema"))
    .filter(([, field]) => field.isOptional())
    .map(([name]) => name);
}

/**
 * Output fields a later step is allowed to reference as
 * `{{<stepId>.outputs.<field>}}`.
 *
 * Derived from the output schema rather than listed. `getAvailableUpstreamOutputs`
 * feeds the canvas's auto-mapper from this, and 37.3's reference validator will
 * check paths against it, so a stale list here is a silent routing defect
 * downstream rather than a cosmetic error.
 */
export function referenceableOutputFields(output: z.ZodType): string[] {
  return Object.keys(objectShape(output, "Capability output schema"));
}

/**
 * The canonical action capability catalog.
 *
 * Total by construction: `satisfies Record<RegisteredActionId, ...>` requires
 * every registered action to appear, and — because `satisfies` applies excess
 * property checking to object literals — rejects an entry with no registration.
 * Registering an executor without describing it, or describing one without
 * registering it, is a compile error in both directions.
 *
 * The runtime registry is the source of truth for membership. This file is the
 * source of truth for what membership means.
 */
export const ActionCapabilities = {
  "task.create": {
    id: "task.create",
    label: "Create a Task",
    description:
      "Create a new task in an existing project. Requires a project id, not a project name; resolve a name to an id before generating a step that uses this action.",

    input: z
      .object({
        title: z
          .string()
          .min(3, "Task title must be at least 3 characters")
          .max(100, "Task title must be at most 100 characters")
          .describe("Short, imperative title for the new task."),

        projectId: z
          .string()
          .cuid("Invalid project ID")
          .describe(
            "Id of the project the task belongs to. Must be an existing project inside this workflow's organization; a cross-organization id is rejected at execution.",
          ),

        description: z
          .string()
          .optional()
          .describe("Optional longer body for the task."),

        assigneeId: z
          .string()
          .cuid("Invalid assignee ID")
          .optional()
          .describe(
            "Optional assignee user id. Must be a member of this workflow's organization; otherwise the action fails.",
          ),

        priority: z
          .enum(["LOW", "MEDIUM", "HIGH"])
          .optional()
          .default("MEDIUM")
          .describe("Task priority. Defaults to MEDIUM when omitted."),
      })
      .strict(),

    // Mirrors the payload returned by createTaskAction
    // (src/lib/workflow/actions/core/create-task.ts:68-71): { taskId, title }.
    // Both are referenceable, because the wrapper persists exactly this object
    // into StepRun.outputs.
    output: z.object({
      taskId: z.string().describe("Id of the created task."),
      title: z.string().describe("Title the task was created with."),
    }),

    // createTaskAction declares no compensate function, so the executor takes
    // the trivially-successful path in wrapper.ts.
    compensation: { available: false },

    failure: {
      isRetriableByDefault: null,
      notes:
        "Non-retriable when the title or projectId is missing, when the workflow row is gone, and when the project or assignee is outside the organization (bad generated config). Retriable on a database error. See createTaskAction.execute.",
    },
  } satisfies ActionCapability,
} satisfies Record<RegisteredActionId, ActionCapability>;

/** Capability lookup by action id. Undefined when the id is not catalogued. */
export function getActionCapability(
  actionId: string,
): ActionCapability | undefined {
  return (
    ActionCapabilities as Record<string, ActionCapability | undefined>
  )[actionId];
}

/**
 * Every catalogued action id, sorted for stable rendering and snapshotting.
 */
export const CAPABILITY_ACTION_IDS: readonly string[] = Object.keys(
  ActionCapabilities,
).sort();
