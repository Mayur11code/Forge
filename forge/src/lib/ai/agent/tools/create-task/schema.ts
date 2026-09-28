import { z } from "zod";

/**
 * Model-controlled input for the createTask tool.
 *
 * There is intentionally NO `orgId` and NO `userId` here. Organization and
 * user identity are supplied by the worker from the persisted AgentSession
 * row and injected via `ToolExecutionContext`.
 *
 * `projectName` is used instead of `projectId` because `Project` is unique on
 * `@@unique([name, orgId])` and a human can say a project name, whereas a CUID
 * cannot be reliably invented by the model. The executor resolves the name to
 * a trusted projectId inside `ctx.orgId` before the write.
 */
export const createTaskSchema = z
  .object({
    title: z
      .string()
      .min(3, "Title must be at least 3 characters.")
      .max(100, "Title must be at most 100 characters.")
      .describe("Short, imperative task title, e.g. 'Fix login redirect bug'."),

    projectName: z
      .string()
      .min(1)
      .max(100)
      .describe(
        "The exact name of the project this task belongs to. Must match an existing project in the user's organization. Do not invent a project that was not listed or discussed.",
      ),

    priority: z
      .enum(["HIGH", "MEDIUM", "LOW"])
      .optional()
      .describe("Task priority. Omit to use the MEDIUM default."),

    assigneeId: z
      .string()
      .cuid()
      .optional()
      .describe(
        "Optional assignee user id. Only supply this when a real user id was already established earlier in the conversation. Omit when unsure.",
      ),
  })
  .strict();
