// src/lib/ai/agent/tools/update-task/index.ts
//
// WRITE tool: updates a task's mutable fields.
//
// Requires user confirmation. The human-supplied `taskTitle` is resolved
// server-side to a real task id inside the trusted org, so the model never
// supplies an id it could not have invented, and an ambiguous title is
// reported rather than resolved by guessing.

import { tool } from "ai";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { ToolResultPart } from "ai";

import type { ToolExecutionContext } from "../../types";
import { resolveTaskInOrg } from "@/lib/tasks/read-tasks";
import { updateTaskInOrg } from "@/lib/tasks/update-task";

import type { TaskOutput } from "../shared-output";

type ToolOutput = ToolResultPart["output"];

const updateTaskSchema = z
  .object({
    taskTitle: z
      .string()
      .min(1)
      .max(100)
      .describe(
        "The title of the task to update, exactly as it appears in the user's organization. Call listTasks first if you are unsure.",
      ),

    status: z
      .enum(["TODO", "IN_PROGRESS", "DONE"])
      .optional()
      .describe("New status. Omit to leave the status unchanged."),

    priority: z
      .enum(["LOW", "MEDIUM", "HIGH"])
      .optional()
      .describe("New priority. Omit to leave the priority unchanged."),

    assigneeId: z
      .string()
      .cuid()
      .nullable()
      .optional()
      .describe(
        "New assignee. Pass null to unassign. Omit to leave the assignee unchanged. Only supply an id that was already established earlier in the conversation.",
      ),
  })
  .strict()
  .refine(
    (value) =>
      value.status !== undefined ||
      value.priority !== undefined ||
      value.assigneeId !== undefined,
    {
      message:
        "Provide at least one of status, priority or assigneeId to change.",
    },
  );

export const updateTaskTool = tool({
  description: [
    "UPDATE an existing task: its status, priority, or assignee.",
    "",
    "Only call this when the user has explicitly asked you to change a task,",
    "for example to mark something done, start work on it, change its",
    "priority, or reassign it. Never call it to restate what you intend to do.",
    "",
    "Identify the task by its title, and make sure you have read the tasks",
    "first so you are updating the right one. If the title is ambiguous the",
    "tool will return the candidates so you can ask the user which they meant.",
    "",
    "Only the fields you supply are changed; anything you omit is left alone.",
    "Do not report the change as applied until this tool returns ok: true.",
  ].join(" "),

  inputSchema: updateTaskSchema,
});

export async function executeUpdateTask(
  input: Prisma.JsonValue,
  ctx: ToolExecutionContext,
): Promise<ToolOutput> {
  if (input === null) {
    throw new Error("Tool input cannot be null.");
  }

  const parsed = updateTaskSchema.safeParse(input);

  if (!parsed.success) {
    const value: TaskOutput = {
      ok: false,
      code: "INVALID_INPUT",
      error:
        parsed.error.issues[0]?.message ?? "Invalid updateTask input.",
    };

    return { type: "json", value };
  }

  const { taskTitle, ...changes } = parsed.data;

  const resolved = await resolveTaskInOrg(ctx.orgId, taskTitle);

  if (resolved.kind === "NOT_FOUND") {
    const value: TaskOutput = {
      ok: false,
      code: "TASK_NOT_FOUND",
      error: `No task titled "${taskTitle}" exists in this organization.`,
    };

    return { type: "json", value };
  }

  if (resolved.kind === "AMBIGUOUS") {
    const value: TaskOutput = {
      ok: false,
      code: "TASK_AMBIGUOUS",
      error: `More than one task is titled "${taskTitle}". Ask the user which one they mean.`,
      suggestions: resolved.candidates.map((task) => ({
        id: task.id,
        name: task.title,
      })),
    };

    return { type: "json", value };
  }

  // The canonical operation re-verifies org ownership and assignee
  // membership. The resolution above is for disambiguation, not for
  // authorization.
  const result = await updateTaskInOrg(
    { taskId: resolved.task.id, ...changes },
    { orgId: ctx.orgId, userId: ctx.userId },
  );

  if (!result.success) {
    const value: TaskOutput = {
      ok: false,
      code: result.code,
      error: result.error,
    };

    return { type: "json", value };
  }

  const value: TaskOutput = {
    ok: true,
    tasks: [
      {
        id: result.task.id,
        title: result.task.title,
        status: result.task.status,
        priority: result.task.priority,
        projectName: resolved.task.projectName,
        assigneeId: result.task.assigneeId,
      },
    ],
  };

  return { type: "json", value };
}

/**
 * Render the persisted update proposal for the confirmation UI.
 *
 * Derived from the same `input` the executor will act on, so the user sees
 * exactly the change that will be made. Omitted fields are shown as unchanged
 * rather than omitted, so a status-only change cannot be mistaken for a
 * full replacement.
 */
export function describeUpdateTaskProposal(
  input: unknown,
): {
  summary: string;
  fields: { label: string; value: string }[];
} | null {
  const parsed = updateTaskSchema.safeParse(input);

  if (!parsed.success) {
    return null;
  }

  const { taskTitle, status, priority, assigneeId } = parsed.data;

  const fields: { label: string; value: string }[] = [
    { label: "Task", value: taskTitle },
  ];

  fields.push({
    label: "Status",
    value: status ?? "unchanged",
  });

  fields.push({
    label: "Priority",
    value: priority ?? "unchanged",
  });

  fields.push({
    label: "Assignee",
    value:
      assigneeId === undefined
        ? "unchanged"
        : assigneeId === null
          ? "unassigned"
          : assigneeId,
  });

  return {
    summary: `Update task "${taskTitle}"`,
    fields,
  };
}
