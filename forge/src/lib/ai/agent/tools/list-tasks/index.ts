// src/lib/ai/agent/tools/list-tasks/index.ts
//
// READ_ONLY tool: lists org-scoped tasks. Changes nothing, so it is dispatched
// immediately with no user confirmation.

import { tool } from "ai";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { ToolResultPart } from "ai";

import type { ToolExecutionContext } from "../../types";
import { listTasksInOrg } from "@/lib/tasks/read-tasks";
import { resolveProjectNameInOrg } from "@/lib/tasks/projects";

import { buildValidationFailure, type TaskOutput } from "../shared-output";

type ToolOutput = ToolResultPart["output"];

const listTasksSchema = z
  .object({
    status: z
      .enum(["TODO", "IN_PROGRESS", "DONE"])
      .optional()
      .describe("Only return tasks in this status."),

    projectName: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Only return tasks in the project with this name. Omit to span all projects.",
      ),

    assigneeId: z
      .string()
      .cuid()
      .optional()
      .describe(
        "Only return tasks assigned to this user. Omit unless a real id was established earlier in the conversation.",
      ),

    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Maximum tasks to return. Defaults to 25, capped at 50."),
  })
  .strict();

export const listTasksTool = tool({
  description: [
    "READ the tasks in the user's organization. This does not modify anything.",
    "",
    "Use it to answer what work exists, what is in progress, or what someone is",
    "assigned. Call it before claiming that a task does or does not exist.",
    "",
    "Results are bounded and newest first. Narrow the request with `status`,",
    "`projectName` or `assigneeId` instead of asking for everything.",
  ].join(" "),

  inputSchema: listTasksSchema,
});

export async function executeListTasks(
  input: Prisma.JsonValue,
  ctx: ToolExecutionContext,
): Promise<ToolOutput> {
  if (input === null) {
    throw new Error("Tool input cannot be null.");
  }

  const parsed = listTasksSchema.safeParse(input);

  if (!parsed.success) {
    const value: TaskOutput = buildValidationFailure(
      parsed.error,
      "listTasks",
    );

    return { type: "json", value };
  }

  const { status, projectName, assigneeId, limit } = parsed.data;

  let projectId: string | undefined;

  if (projectName) {
    // Resolved inside the trusted org. The model never sends a projectId.
    const resolved = await resolveProjectNameInOrg(
      ctx.orgId,
      projectName,
    );

    if (resolved.kind === "NOT_FOUND") {
      const value: TaskOutput = {
        ok: false,
        code: "PROJECT_NOT_FOUND",
        error: `No project named "${projectName}" exists in this organization.`,
      };

      return { type: "json", value };
    }

    if (resolved.kind === "AMBIGUOUS") {
      const value: TaskOutput = {
        ok: false,
        code: "PROJECT_AMBIGUOUS",
        error: `More than one project matches "${projectName}". Ask the user which one they mean.`,
        suggestions: resolved.candidates.map((project) => ({
          id: project.id,
          name: project.name,
        })),
      };

      return { type: "json", value };
    }

    projectId = resolved.project.id;
  }

  const tasks = await listTasksInOrg(ctx.orgId, {
    take: limit ?? 25,
    ...(status ? { status } : {}),
    ...(projectId ? { projectId } : {}),
    ...(assigneeId ? { assigneeId } : {}),
  });

  const value: TaskOutput = {
    ok: true,
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      projectName: task.projectName,
      assigneeId: task.assigneeId,
    })),
  };

  return { type: "json", value };
}
