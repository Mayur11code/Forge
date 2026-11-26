import { auth } from "@/lib/auth/auth";
import { db } from "@/lib/prisma/db";
import { notFound } from "next/navigation";
import TaskBox from "@/features/organizations/components/Taskbox";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { toTaskStatus, toTaskPriority, resolveTaskAssigneeFilter } from "@/lib/tasks/filters";
import ProjectSettingsModal from "@/features/projects/components/ProjectSettingsModal";
import { Archive } from "lucide-react";

const PAGE_SIZE = 12;

export default async function ProjectTasksPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; projectId: string }>;
  searchParams?: Promise<{
    query?: string;
    status?: string;
    priority?: string;
    assignee?: string;
    page?: string;
  }>;
}) {
  const { orgId, projectId } = await params;
  const sparams = await searchParams;
  

  // 1️⃣ Org access (RBAC boundary)
  // await requireOrgAccess(orgId);
  const access = await getOrgAccess(orgId);
  if (!access) notFound();

  // 1. Fetch the organization using the slug from the URL
  const organization = await db.organization.findUnique({
    where: { slug: orgId }, // assuming 'orgId' variable holds 'forge-hq'
  });

  if (organization === null) {
    return notFound();
  }

  // 🔎 Extract filters from URL
  const query =
    typeof sparams?.query === "string"
      ? sparams.query
      : undefined;

  const status =
    typeof sparams?.status === "string"
      ? sparams.status
      : undefined;

  const priority =
    typeof sparams?.priority === "string"
      ? sparams.priority
      : undefined;

  const assignee =
    typeof sparams?.assignee === "string"
      ? sparams.assignee.trim()
      : undefined;

  // Validated against the Prisma enums rather than cast: an unknown value in the
  // URL is a stale bookmark, not a server error.
  const taskStatus = toTaskStatus(status);
  const taskPriority = toTaskPriority(priority);

  // 2️⃣ Fetch project (scoped!)
  const project = await db.project.findFirst({
    where: {
      id: projectId,
      orgId: organization.id,
    },
  });

  if (!project) {
    return notFound();
  }

  // Fetch organization members to enable verified assignee filtering
  const memberships = await db.membership.findMany({
    where: { orgId: organization.id },
    include: {
      user: {
        select: { id: true, name: true, email: true },
      },
    },
    orderBy: [{ createdAt: "asc" }],
  });

  const members = memberships
    .filter((m) => m.user !== null)
    .map((m) => ({
      id: m.user!.id,
      name: m.user!.name?.trim() || m.user!.email?.split("@")[0] || "Unknown User",
      email: m.user!.email,
    }));

  const taskAssignee = resolveTaskAssigneeFilter(
    assignee,
    members.map((m) => m.id)
  );

  const page = Math.max(1, Number(sparams?.page) || 1);

  // Where predicate for tasks scoped to this project
  const where = {
    projectId: project.id,
    ...(taskStatus && { status: taskStatus }),
    ...(taskPriority && { priority: taskPriority }),
    ...(taskAssignee === null
      ? { assigneeId: null }
      : taskAssignee !== undefined
      ? { assigneeId: taskAssignee }
      : {}),
    ...(query && {
      OR: [
        {
          title: {
            contains: query,
            mode: "insensitive" as const,
          },
        },
        {
          description: {
            contains: query,
            mode: "insensitive" as const,
          },
        },
      ],
    }),
  };

  // Deterministic server-side pagination (P15)
  const totalCount = await db.task.count({ where });
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const skip = (currentPage - 1) * PAGE_SIZE;

  const tasks = await db.task.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    skip,
    take: PAGE_SIZE,
  });

  console.log(
    "🚀 PROJECT TASKS PAGE - Project:",
    project.name,
    "with",
    tasks.length,
    "tasks."
  );

  const canManage =
    access.membership.role === "ADMIN" || access.membership.role === "MANAGER";

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Project Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-zinc-800/80 pb-5">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-white">{project.name}</h1>
            {project.archivedAt && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-xs font-semibold text-amber-400">
                <Archive className="w-3 h-3" />
                Archived
              </span>
            )}
          </div>
          {project.description && (
            <p className="text-sm text-zinc-400 mt-1">{project.description}</p>
          )}
        </div>

        {canManage && (
          <div>
            <ProjectSettingsModal
              orgSlug={orgId}
              project={project}
            />
          </div>
        )}
      </div>

      {/* Archived Notice Banner */}
      {project.archivedAt && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-xs text-amber-300/90 flex items-center gap-2">
          <Archive className="w-4 h-4 text-amber-400 shrink-0" />
          <span>This project is currently archived. It is hidden from standard team views and active automation triggers.</span>
        </div>
      )}

      <TaskBox
        mode="project"
        param={{ orgId }}
        projectId={project.id}
        initialtasks={tasks}
        totalCount={totalCount}
        currentPage={currentPage}
        totalPages={totalPages}
        pageSize={PAGE_SIZE}
        members={members}
      />
    </div>
  );
}
