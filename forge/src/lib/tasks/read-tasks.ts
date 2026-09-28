// src/lib/tasks/read-tasks.ts
//
// CANONICAL org-scoped task reads.
//
// Same contract as create-task.ts:
// - `orgId` is TRUSTED and comes from the persisted AgentSession (or an
//   authenticated server context). It is never model input.
// - No function here accepts an orgId from the model.
//
// `Task` has no `orgId` column; org membership is reached through
// `project.orgId`. Every query below therefore filters on the project
// relation. A `where: { id }` alone would happily return another org's task,
// which is the single easiest way to leak data in this schema.

import { prisma } from "@/lib/prisma/extended";
import { TaskPriority, TaskStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";

export type TaskSummary = {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  projectId: string;
  projectName: string;
  assigneeId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const taskSummarySelect = {
  id: true,
  title: true,
  status: true,
  priority: true,
  projectId: true,
  assigneeId: true,
  createdAt: true,
  updatedAt: true,
  project: { select: { name: true } },
} satisfies Prisma.TaskSelect;

type TaskSummaryRow = Prisma.TaskGetPayload<{
  select: typeof taskSummarySelect;
}>;

function toSummary(row: TaskSummaryRow): TaskSummary {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    projectId: row.projectId,
    projectName: row.project.name,
    assigneeId: row.assigneeId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type ListTasksOptions = {
  take?: number;
  status?: TaskStatus;
  projectId?: string;
  assigneeId?: string;
};

/**
 * List tasks inside a trusted org, newest first.
 *
 * `take` is clamped server-side. An agent that asks for "everything" gets a
 * bounded page rather than an unbounded scan, and it cannot turn a read tool
 * into a denial-of-service vector.
 */
export async function listTasksInOrg(
  orgId: string,
  { take = 25, status, projectId, assigneeId }: ListTasksOptions = {},
): Promise<TaskSummary[]> {
  const rows = await prisma.task.findMany({
    where: {
      project: { orgId },
      ...(status ? { status } : {}),
      ...(projectId ? { projectId } : {}),
      ...(assigneeId ? { assigneeId } : {}),
    },
    select: taskSummarySelect,
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(take, 1), 100),
  });

  return rows.map(toSummary);
}

/**
 * Fetch one task by id, scoped to a trusted org.
 *
 * Returns null for a task that does not exist AND for a task belonging to
 * another org, so this cannot be used to probe for task ids across tenants.
 */
export async function getTaskInOrg(
  orgId: string,
  taskId: string,
): Promise<TaskSummary | null> {
  const row = await prisma.task.findFirst({
    where: { id: taskId, project: { orgId } },
    select: taskSummarySelect,
  });

  return row ? toSummary(row) : null;
}

/**
 * Fetch a task by a human-supplied reference inside a trusted org.
 *
 * Accepts either a real task id or a human title, because a person says
 * "the login bug task", not "clx...". Titles are only used when they resolve
 * to exactly one task; several matches are reported as ambiguous so the
 * caller can ask the user which one they meant rather than mutating an
 * arbitrary row.
 */
export type ResolveTaskResult =
  | { kind: "FOUND"; task: TaskSummary }
  | { kind: "NOT_FOUND" }
  | { kind: "AMBIGUOUS"; candidates: TaskSummary[] };

export async function resolveTaskInOrg(
  orgId: string,
  reference: string,
): Promise<ResolveTaskResult> {
  const value = reference.trim();

  if (!value) {
    return { kind: "NOT_FOUND" };
  }

  const byId = await getTaskInOrg(orgId, value);

  if (byId) {
    return { kind: "FOUND", task: byId };
  }

  const matches = await prisma.task.findMany({
    where: {
      project: { orgId },
      title: { equals: value, mode: "insensitive" },
    },
    select: taskSummarySelect,
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  if (matches.length === 1) {
    return { kind: "FOUND", task: toSummary(matches[0]!) };
  }

  if (matches.length === 0) {
    return { kind: "NOT_FOUND" };
  }

  return {
    kind: "AMBIGUOUS",
    candidates: matches.map(toSummary),
  };
}
