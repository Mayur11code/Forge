// src/lib/tasks/projects.ts
//
// Worker-safe, org-scoped project reads.
//
// The agent needs a way to turn something a human can say ("the Marketing
// project") into a trusted `projectId`. Gemini cannot reliably invent a CUID,
// so we resolve names here, always inside a trusted org boundary.
//
// Security contract:
// - `orgId` is TRUSTED and supplied by the caller (persisted AgentSession).
//   It is never taken from LLM input.
// - No function here accepts an orgId from the model.

import { prisma } from "@/lib/prisma/extended";
import type { Prisma } from "@prisma/client";

export type ProjectSummary = {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  taskCount: number;
};

const projectSummarySelect = {
  id: true,
  name: true,
  description: true,
  createdAt: true,
  _count: { select: { tasks: true } },
} satisfies Prisma.ProjectSelect;

type ProjectRow = Prisma.ProjectGetPayload<{
  select: typeof projectSummarySelect;
}>;

function toSummary(row: ProjectRow): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt,
    taskCount: row._count.tasks,
  };
}

export type ListProjectsOptions = {
  take?: number;
};

/**
 * List every project inside a trusted org. Newest first.
 */
export async function listProjectsInOrg(
  orgId: string,
  { take = 50 }: ListProjectsOptions = {},
): Promise<ProjectSummary[]> {
  const rows = await prisma.project.findMany({
    where: { orgId },
    select: projectSummarySelect,
    orderBy: { createdAt: "desc" },
    take,
  });

  return rows.map(toSummary);
}

/**
 * Substring search over project name/description inside a trusted org.
 */
export async function searchProjectsInOrg(
  orgId: string,
  query: string,
  { take = 10 }: ListProjectsOptions = {},
): Promise<ProjectSummary[]> {
  const trimmed = query.trim();

  if (!trimmed) {
    return listProjectsInOrg(orgId, { take });
  }

  const rows = await prisma.project.findMany({
    where: {
      orgId,
      OR: [
        { name: { contains: trimmed, mode: "insensitive" } },
        { description: { contains: trimmed, mode: "insensitive" } },
      ],
    },
    select: projectSummarySelect,
    orderBy: { name: "asc" },
    take,
  });

  return rows.map(toSummary);
}

export type ResolveProjectResult =
  | { kind: "FOUND"; project: ProjectSummary }
  | { kind: "NOT_FOUND" }
  | { kind: "AMBIGUOUS"; candidates: ProjectSummary[] };

/**
 * Resolve a human-supplied project name to a trusted project inside the org.
 *
 * Resolution order:
 *  1. case-insensitive EXACT name match. `Project` has `@@unique([name, orgId])`
 *     so an exact match is unambiguous.
 *  2. case-insensitive SUBSTRING match. Only accepted when it yields exactly
 *     one candidate, otherwise reported as AMBIGUOUS so the caller can ask the
 *     user to disambiguate.
 *
 * Never returns a project from another org.
 */
export async function resolveProjectNameInOrg(
  orgId: string,
  projectName: string,
): Promise<ResolveProjectResult> {
  const name = projectName.trim();

  if (!name) {
    return { kind: "NOT_FOUND" };
  }

  const exact = await prisma.project.findFirst({
    where: {
      orgId,
      name: { equals: name, mode: "insensitive" },
    },
    select: projectSummarySelect,
  });

  if (exact) {
    return { kind: "FOUND", project: toSummary(exact) };
  }

  const candidates = await searchProjectsInOrg(orgId, name, { take: 5 });

  if (candidates.length === 1) {
    return { kind: "FOUND", project: candidates[0]! };
  }

  if (candidates.length === 0) {
    return { kind: "NOT_FOUND" };
  }

  return { kind: "AMBIGUOUS", candidates };
}
