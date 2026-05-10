import { z } from "zod";

// -----------------------------
// EVENT TYPES
// -----------------------------
export const EventTypes = [
  "TASK_CREATED",
  "TASK_COMPLETED",
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
  "EXECUTE_WORKFLOW_NODE" // <-- Successfully registered
] as const;

export type EventType = (typeof EventTypes)[number];

// -----------------------------
// BASE SCHEMA
// -----------------------------
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
  
  // -----------------------------
  // WORKFLOW ENGINE INTEGRATION
  // -----------------------------
  EXECUTE_WORKFLOW_NODE: z.object({
    runId: z.string(),
    stepRunId: z.string(),
  }),
  
} satisfies Record<EventType, z.ZodTypeAny>;

// -----------------------------
// INFERRED TYPES (VERY IMPORTANT)
// -----------------------------
export type EventPayloadMap = {
  [K in EventType]: z.infer<(typeof eventSchemas)[K]>;
};