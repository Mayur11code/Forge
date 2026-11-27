// src/lib/workflow-types/action-capabilities.ts
//
// THE PLANNER-FACING ACTION CAPABILITY CATALOG.
//
// One machine-readable description per action: what it accepts, what it
// produces, and what it costs to fail. This is what a model reads when it
// decides whether a generated workflow step is valid, and what the canvas reads
// when it decides which fields to show and which outputs can be wired.
//
// Client-safe by construction. It imports `zod` and nothing else at runtime.

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
   * STRICT object schema for model-supplied inputs.
   */
  input: z.ZodType;
  /**
   * Object schema for the SUCCESSFUL business payload only.
   */
  output: z.ZodType;
  /**
   * Whether the action defines a compensation function.
   */
  compensation: { available: boolean };
  /**
   * Documented failure behaviour.
   */
  failure: {
    isRetriableByDefault: boolean | null;
    notes: string;
  };
};

function objectShape(schema: z.ZodType, context: string): Record<string, z.ZodType> {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error(
      `${context} must be a z.object(...) so its fields can be derived. ` +
        `A hand-maintained field list is the failure mode this module prevents.`,
    );
  }
  return schema.shape as Record<string, z.ZodType>;
}

export function inputFields(input: z.ZodType): {
  name: string;
  field: z.ZodType;
}[] {
  return Object.entries(objectShape(input, "Capability input schema")).map(
    ([name, field]) => ({ name, field }),
  );
}

export function requiredInputFields(input: z.ZodType): string[] {
  return Object.entries(objectShape(input, "Capability input schema"))
    .filter(([, field]) => !field.isOptional())
    .map(([name]) => name);
}

export function optionalInputFields(input: z.ZodType): string[] {
  return Object.entries(objectShape(input, "Capability input schema"))
    .filter(([, field]) => field.isOptional())
    .map(([name]) => name);
}

export function referenceableOutputFields(output: z.ZodType): string[] {
  return Object.keys(objectShape(output, "Capability output schema"));
}

/**
 * The canonical action capability catalog.
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

    output: z.object({
      taskId: z.string().describe("Id of the created task."),
      title: z.string().describe("Title the task was created with."),
    }),

    // Reconciled: createTaskAction defines transactional compensation
    compensation: { available: true },

    failure: {
      isRetriableByDefault: null,
      notes:
        "Non-retriable when the title or projectId is missing, when the workflow row is gone, and when the project or assignee is outside the organization (bad generated config). Retriable on a database error. See createTaskAction.execute.",
    },
  } satisfies ActionCapability,

  "task.update": {
    id: "task.update",
    label: "Update a Task",
    description: "Update the status, priority, title, description, or assignee of an existing task within the organization.",

    input: z
      .object({
        taskId: z.string().describe("Id of the task to update."),
        title: z.string().min(1).max(100).optional().describe("Updated task title."),
        status: z.enum(["TODO", "IN_PROGRESS", "BLOCKED", "DONE"]).optional().describe("Updated task execution status."),
        priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional().describe("Updated task priority."),
        description: z.string().optional().describe("Updated task description body."),
        assigneeId: z.string().cuid().optional().describe("Updated assignee user ID."),
      })
      .strict(),

    output: z.object({
      taskId: z.string().describe("Id of the updated task."),
      title: z.string().optional().describe("Updated task title."),
      status: z.string().optional().describe("Updated task status."),
      priority: z.string().optional().describe("Updated task priority."),
      assigneeId: z.string().nullable().optional().describe("Updated assignee user ID."),
      previousState: z.record(z.string(), z.any()).optional().describe("Atomic pre-state snapshot for rollback."),
    }),

    compensation: { available: true },

    failure: {
      isRetriableByDefault: true,
      notes: "Non-retriable on invalid input or task not found. Retriable on transient database errors.",
    },
  } satisfies ActionCapability,

  "comment.create": {
    id: "comment.create",
    label: "Create a Comment",
    description: "Post an automated comment on an existing task within the organization.",

    input: z
      .object({
        taskId: z.string().describe("Id of the task to comment on."),
        content: z.string().min(1, "Comment content cannot be empty").describe("Text content of the comment."),
        userId: z.string().optional().describe("Optional author user ID. Defaults to organization owner/system bot if omitted."),
      })
      .strict(),

    output: z.object({
      commentId: z.string().describe("Id of the created comment."),
      taskId: z.string().describe("Target task ID."),
      content: z.string().describe("Body text of the comment."),
      userId: z.string().optional().describe("Author user ID."),
      createdAt: z.string().optional().describe("Creation timestamp."),
    }),

    compensation: { available: true },

    failure: {
      isRetriableByDefault: true,
      notes: "Non-retriable on missing task or empty content. Retriable on database connection errors.",
    },
  } satisfies ActionCapability,

  "email.send": {
    id: "email.send",
    label: "Send Email",
    description: "Send an automated notification email via Resend.",

    input: z
      .object({
        toEmail: z.string().min(1, "Recipient email is required").describe("Recipient email address."),
        subject: z.string().min(1, "Subject is required").describe("Subject line for the email."),
        bodyText: z.string().optional().describe("Body content for the email."),
        attachmentUrl: z.string().optional().describe("Optional public artifact URL to attach."),
        attachmentName: z.string().optional().describe("Optional filename for the attachment."),
      })
      .strict(),

    output: z.object({
      resendId: z.string().nullable().describe("Provider message ID returned by Resend."),
      deliveredTo: z.string().describe("Target recipient email address."),
      messageId: z.string().nullable().optional().describe("Message tracking ID."),
    }),

    compensation: { available: false },

    failure: {
      isRetriableByDefault: true,
      notes: "Non-retriable on validation error or malformed address. Retriable on rate limit or network error.",
    },
  } satisfies ActionCapability,

  "report.generate": {
    id: "report.generate",
    label: "Generate Report",
    description: "Compile a real Markdown progress report from project tasks and upload to UploadThing.",

    input: z
      .object({
        projectId: z.string().optional().describe("Optional project ID to scope task metrics."),
        title: z.string().optional().describe("Optional custom title for the report."),
        userName: z.string().optional().describe("Name of the user or system requesting the report."),
        templateId: z.string().optional().describe("Optional template identifier."),
      })
      .strict(),

    output: z.object({
      documentUrl: z.string().describe("Public URL of the uploaded Markdown report artifact."),
      fileKey: z.string().describe("UploadThing file key used for saga compensation cleanup."),
      fileName: z.string().describe("Uploaded filename."),
      sizeBytes: z.number().describe("Artifact size in bytes."),
      markdownContent: z.string().optional().describe("Generated Markdown document content."),
    }),

    compensation: { available: true },

    failure: {
      isRetriableByDefault: true,
      notes: "Retriable on temporary storage or network upload errors.",
    },
  } satisfies ActionCapability,

  "logic.condition": {
    id: "logic.condition",
    label: "Condition",
    description: "Evaluate a logical comparison between two operands to control DAG branch routing.",

    input: z
      .object({
        value1: z.any().describe("Left-hand operand."),
        operator: z
          .enum(["==", "===", "!=", "!==", ">", "<", ">=", "<=", "CONTAINS"])
          .describe("Comparison operator."),
        value2: z.any().describe("Right-hand operand."),
      })
      .strict(),

    output: z.object({
      branch: z.enum(["TRUE", "FALSE"]).describe("Branch chosen by the condition evaluation."),
      details: z.string().optional().describe("Evaluation trace string."),
      conditionMet: z.boolean().optional().describe("Boolean outcome of the condition."),
    }),

    compensation: { available: false },

    failure: {
      isRetriableByDefault: false,
      notes: "Deterministic logic operation; non-retriable on bad operators.",
    },
  } satisfies ActionCapability,

  "http.request": {
    id: "http.request",
    label: "HTTP Request",
    description: "Dispatch an outbound HTTP webhook request protected by strict SSRF defense.",

    input: z
      .object({
        url: z.string().min(1, "URL is required").describe("Target destination URL (HTTP or HTTPS)."),
        method: z
          .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
          .optional()
          .default("GET")
          .describe("HTTP method to execute."),
        headers: z.record(z.string(), z.string()).optional().describe("Optional request headers."),
        body: z.any().optional().describe("Optional request payload body."),
        timeout: z.number().optional().describe("Request timeout in milliseconds (max 10000ms)."),
      })
      .strict(),

    output: z.object({
      status: z.number().describe("HTTP response status code."),
      statusText: z.string().describe("HTTP status message."),
      data: z.any().optional().describe("Parsed JSON response data if applicable."),
      text: z.string().optional().describe("Bounded response body text."),
      headers: z.record(z.string(), z.string()).optional().describe("Redacted response headers."),
      effectiveUrl: z.string().optional().describe("Final effective URL after redirects."),
      pinnedIp: z.string().optional().describe("Pinned socket IP address."),
    }),

    compensation: { available: false },

    failure: {
      isRetriableByDefault: false,
      notes: "Non-retriable on SSRF security policy violations or 4xx client errors. Retriable on 5xx or 429.",
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
