import { z } from "zod";

export const EventTypes = [
  "TASK_CREATED",
  "TASK_COMPLETED",
  "TASK_UPDATED",
  "TASK_DELETED",
  "FILE_UPLOADED",
  "SEND_EMAIL",
  "PROCESS_FILE",
  "EMBEDDING_REQUESTED",
  "AI_SUMMARY_REQUESTED",
  "ANALYTICS_EVENT",
  "CRON_DAILY_DIGEST",
  "NOTIFY_PROJECT_OWNER",
  "GENERATE_COMPLETION_REPORT",
  "CREATE_DEFAULT_ORG",
  "SEND_WELCOME_EMAIL",
  "EXECUTE_WORKFLOW_NODE",
  "ADVANCE_WORKFLOW",
  "WORKFLOW_MAINTENANCE_REQUESTED",
  "AGENT_LOOP_REQUESTED",
  "AGENT_TOOL_EXECUTION_REQUESTED",
  "AGENT_MAINTENANCE_REQUESTED",
] as const;

export type EventType = (typeof EventTypes)[number];


const baseEventSchema = z.object({
  orgId: z.string(),
  actorId: z.string().optional(),
});

// -----------------------------
// EVENT SCHEMAS
// -----------------------------
export const eventSchemas = {
  TASK_CREATED: baseEventSchema.extend({
    taskId: z.string(),
    projectId: z.string(),
  }),

  TASK_UPDATED: baseEventSchema.extend({
    taskId: z.string(),
    projectId: z.string(),
  }),

  TASK_DELETED: baseEventSchema.extend({
    taskId: z.string(),
    projectId: z.string(),
  }),

  TASK_COMPLETED: baseEventSchema.extend({
    taskId: z.string(),
  }),

  FILE_UPLOADED: baseEventSchema.extend({
    fileId: z.string(),
    taskId: z.string(),
  }),

  SEND_EMAIL: baseEventSchema.extend({
    userId: z.string(),
    subject: z.string(),
    body: z.string(),
  }),

  PROCESS_FILE: baseEventSchema.extend({
    fileId: z.string(),
  }),

  EMBEDDING_REQUESTED: baseEventSchema.extend({
    entityId: z.string(),
    type: z.enum(["TASK", "ATTACHMENT"]),
  }),

  AI_SUMMARY_REQUESTED: baseEventSchema.extend({
    projectId: z.string(),
  }),

  ANALYTICS_EVENT: baseEventSchema.extend({
    eventName: z.string(),
    metadata: z.record(z.string(), z.any()),
  }),

  CRON_DAILY_DIGEST: baseEventSchema,

  NOTIFY_PROJECT_OWNER: baseEventSchema.extend({
    projectId: z.string(),
  }),

  GENERATE_COMPLETION_REPORT: baseEventSchema.extend({
    projectId: z.string(),
  }),

  CREATE_DEFAULT_ORG: baseEventSchema,

  SEND_WELCOME_EMAIL: baseEventSchema.extend({
    userId: z.string(),
  }),

  EXECUTE_WORKFLOW_NODE: z.object({
    runId: z.string(),
    stepRunId: z.string(),
    kind: z.enum(["TRIGGER", "ACTION"]),

  }),

  /**
   * Re-entry into the workflow evaluator.
   *
   * Not `baseEventSchema`, for the same reason `EXECUTE_WORKFLOW_NODE` is not: a
   * run belongs to an organization, but the durable re-entry is published by the
   * engine itself while it is mid-flight, and the org is not what the consumer
   * needs. Carrying a redundant `orgId` here would mean trusting a field that
   * nothing on the consuming path checks.
   *
   * There is no `stepRunId`: the whole point is to re-evaluate the run from a
   * fresh read, because the caller could not prove which step it was waiting on.
   */
  ADVANCE_WORKFLOW: z.object({
    runId: z.string(),
  }),

  /**
   * The scheduled workflow upkeep pass.
   *
   * Same reasoning as `AGENT_MAINTENANCE_REQUESTED`, and deliberately kept as a
   * separate event rather than folded into it: the two sweeps have different
   * risk profiles and must be able to be scheduled and observed independently.
   * One recovers abandoned agent sessions, the other fails steps whose outcome
   * is unknown. Conflating them would make it impossible to disable the more
   * dangerous duty without losing the harmless one.
   *
   * `.strict()` for the same reason: this payload is written by hand in a QStash
   * schedule body and never passes through TypeScript, so a typo must fail
   * loudly rather than silently falling back to the default batch size.
   */
  WORKFLOW_MAINTENANCE_REQUESTED: z
    .object({
      limit: z.number().int().min(1).max(1000).default(100),
    })
    .strict(),

  AGENT_LOOP_REQUESTED: baseEventSchema.extend({
    sessionId: z.string(),
    expectedStep: z.number().int().min(0),
  }),

  AGENT_TOOL_EXECUTION_REQUESTED: baseEventSchema.extend({
    sessionId: z.string(),
    executionId: z.string(),
    expectedStep: z.number().int().min(0),
  }),

  /**
   * The scheduled upkeep pass, published by a QStash schedule rather than by any
   * agent.
   *
   * Deliberately NOT `baseEventSchema`: maintenance is system-wide and sweeps
   * every organization, so there is no single `orgId` that would be true. Putting
   * one here would mean inventing a sentinel organization and then filtering or
   * ignoring it downstream - exactly the kind of lie that quietly becomes a
   * tenant-isolation bug. `EXECUTE_WORKFLOW_NODE` sets the precedent of a
   * non-base schema.
   *
   * The field is `limit`, not `batchSize` or `count`, and it is bounded in the
   * schema on purpose. A scheduled trigger is an external input: anyone who can
   * publish to the `events` topic can shape the payload, and an unbounded
   * `take` would let a single message turn a five-minute sweep into a
   * table-scanning request against production.
   */
  AGENT_MAINTENANCE_REQUESTED: z
    .object({
      limit: z.number().int().min(1).max(1000).default(100),
    })
    // `.strict()`, unlike every other schema here, because this payload is
    // written by hand in a QStash schedule body and never travels through
    // TypeScript. A default Zod object silently strips unknown keys, so a
    // misspelled `limitt` would pass validation and then sweep with the default
    // 100 - a schedule that reads as configured and is not. Failing loudly is the
    // only useful answer to a typo in an external config.
    .strict(),

} satisfies Record<EventType, z.ZodTypeAny>;

// -----------------------------
// INFERRED TYPES
// -----------------------------
export type EventPayloadMap = {
  [K in EventType]: z.infer<(typeof eventSchemas)[K]>;
};