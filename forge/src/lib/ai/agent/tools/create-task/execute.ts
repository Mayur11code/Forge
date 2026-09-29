import type { Prisma } from "@prisma/client";
import type { ToolResultPart } from "ai";

import type { ToolExecutionContext } from "../../types";
import {
  listProjectsInOrg,
  resolveProjectNameInOrg,
} from "@/lib/tasks/projects";
import { createTaskInOrg } from "@/lib/tasks/create-task";

import { createTaskSchema } from "./schema";
import type { CreateTaskOutput } from "./types";
import { buildValidationFailure } from "../shared-output";

type ToolOutput = ToolResultPart["output"];

function toSuggestions(
  projects: readonly { id: string; name: string }[],
): CreateTaskOutput["suggestions"] {
  return projects.map((project) => ({
    id: project.id,
    name: project.name,
  }));
}

async function availableProjects(
  ctx: ToolExecutionContext,
): Promise<CreateTaskOutput["suggestions"]> {
  const projects = await listProjectsInOrg(ctx.orgId, { take: 10 });
  return toSuggestions(projects);
}

/**
 * Executor for the createTask agent tool.
 *
 * Responsibilities:
 *  1. Validate the model-controlled payload.
 *  2. Resolve the human-supplied `projectName` to a trusted projectId INSIDE
 *     `ctx.orgId`. The model never supplies an org or a project id directly.
 *  3. Delegate the write to the canonical task operation.
 *
 * There is no Prisma usage in this file and no task business logic here. The
 * canonical operation owns the single `prisma.task.create` and the CDC.
 */
export async function executeCreateTask(
  input: Prisma.JsonValue,
  ctx: ToolExecutionContext,
): Promise<ToolOutput> {
  if (input === null) {
    throw new Error("Tool input cannot be null.");
  }

  const parsed = createTaskSchema.safeParse(input);

  if (!parsed.success) {
    const value: CreateTaskOutput = buildValidationFailure(
      parsed.error,
      "createTask",
    );

    return { type: "json", value };
  }

  const { projectName, ...taskFields } = parsed.data;

  // Resolve the project the user actually named, scoped to the trusted org.
  const resolved = await resolveProjectNameInOrg(ctx.orgId, projectName);

  if (resolved.kind === "NOT_FOUND") {
    const value: CreateTaskOutput = {
      ok: false,
      code: "PROJECT_NOT_FOUND",
      error: `No project named "${projectName}" exists in this organization.`,
      suggestions: await availableProjects(ctx),
    };

    return { type: "json", value };
  }

  if (resolved.kind === "AMBIGUOUS") {
    const value: CreateTaskOutput = {
      ok: false,
      code: "PROJECT_AMBIGUOUS",
      error: `More than one project matches "${projectName}". Ask the user which one they mean.`,
      suggestions: toSuggestions(resolved.candidates),
    };

    return { type: "json", value };
  }

  // Canonical operation. Trusted org/user come from ctx, never from input.
  const result = await createTaskInOrg(
    {
      ...taskFields,
      projectId: resolved.project.id,
    },
    {
      orgId: ctx.orgId,
      userId: ctx.userId,
    },
  );

  if (!result.success) {
    const value: CreateTaskOutput = {
      ok: false,
      code: result.code,
      error: result.error,
    };

    return { type: "json", value };
  }

  const value: CreateTaskOutput = {
    ok: true,
    task: {
      id: result.task.id,
      title: result.task.title,
      projectId: result.task.projectId,
      projectName: resolved.project.name,
      status: String(result.task.status),
      priority: String(result.task.priority),
      assigneeId: result.task.assigneeId,
      createdAt: result.task.createdAt.toISOString(),
    },
  };

  return { type: "json", value };
}
