import { auth } from "@/lib/auth/auth";
import TaskBox from "@/features/organizations/components/Taskbox";
import { db } from "@/lib/prisma/db";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { notFound } from "next/navigation";
import {
  resolveTaskStatusFilter,
  toTaskPriority,
  resolveTaskAssigneeFilter,
} from "@/lib/tasks/filters";

const PAGE_SIZE = 12;

export default async function TasksPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams?: Promise<{
    query?: string;
    status?: string;
    priority?: string;
    assignee?: string;
    filter?: string;
    page?: string;
  }>;
}) {
  const { orgId } = await params;
  const resolvedSearchParams = await searchParams;

  const query =
    typeof resolvedSearchParams?.query === "string"
      ? resolvedSearchParams.query.trim()
      : undefined;

  const status =
    typeof resolvedSearchParams?.status === "string"
      ? resolvedSearchParams.status
      : undefined;

  const priority =
    typeof resolvedSearchParams?.priority === "string"
      ? resolvedSearchParams.priority
      : undefined;

  const assignee =
    typeof resolvedSearchParams?.assignee === "string"
      ? resolvedSearchParams.assignee.trim()
      : undefined;

  const filter =
    typeof resolvedSearchParams?.filter === "string"
      ? resolvedSearchParams.filter
      : "ALL";

  const page = Math.max(1, Number(resolvedSearchParams?.page) || 1);

  const taskStatus = resolveTaskStatusFilter({ status, filter });
  const taskPriority = toTaskPriority(priority);

  // 🔐 Auth + org guard
  const access = await getOrgAccess(orgId);
  if (!access) notFound();

  const session = await auth();

  const organization = await db.organization.findUnique({
    where: { slug: orgId },
  });

  if (!organization) {
    notFound();
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

  // Common where predicate with strict tenant scoping (P6)
  const where = {
    project: {
      orgId: organization.id,
      archivedAt: null, // active tasks ignore archived projects
    },
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

  // Deterministic Server-Side Pagination (P15)
  const totalCount = await db.task.count({ where });
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const skip = (currentPage - 1) * PAGE_SIZE;

  const tasks = await db.task.findMany({
    where,
    include: {
      project: {
        select: { id: true, name: true },
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    skip,
    take: PAGE_SIZE,
  });

  return (
    <div className="space-y-6 max-w-7xl mx-auto p-2">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-zinc-800/80 pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">All Tasks</h1>
          <p className="text-xs text-zinc-400 mt-1">
            Aggregated cross-project task pipeline for <span className="text-zinc-200 font-medium">{organization.name}</span>
          </p>
        </div>

        <div className="text-xs text-zinc-500">
          Viewing as <span className="font-mono text-zinc-300">{session?.user?.name || session?.user?.email}</span>
        </div>
      </div>

      <TaskBox
        mode="org"
        param={{ orgId }}
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
