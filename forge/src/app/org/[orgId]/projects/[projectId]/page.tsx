import { auth } from "@/lib/auth/auth";
import { db } from "@/lib/prisma/db";
import { notFound } from "next/navigation";
import TaskBox from "@/features/organizations/components/Taskbox";
// import { requireOrgAccess } from "@/features/organizations/require-org-access";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { Prisma } from "@prisma/client";

export default async function ProjectTasksPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; projectId: string }>;
  searchParams?:Promise< {
    query?: string;
    status?: string;
    priority?: string;
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

  // 2️⃣ Fetch project (scoped!)
  const project = await db.project.findFirst({
    where: {
      id: projectId,
      orgId: organization.id,
    },
  });

  if (!project) {
    console.log("id mismatch");
    return notFound();
  }

  // 🔥 3️⃣ Fetch tasks separately with dynamic filtering
  const tasks = await db.task.findMany({
    where: {
      projectId: project.id,

      ...(status && { status: status as any }),
      ...(priority && { priority: priority as any }),

      ...(query && {
        OR: [
          {
            title: {
              contains: query,
              mode: "insensitive",
            },
          },
          {
            description: {
              contains: query,
              mode: "insensitive",
            },
          },
        ],
      }),
    },

    orderBy: { createdAt: "asc" },

    take: 50, // pagination-ready
  });

  console.log(
    "🚀 PROJECT TASKS PAGE - Project:",
    project.name,
    "with",
    tasks.length,
    "tasks."
  );

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{project.name}</h1>
      <p className="text-gray-500">{project.description}</p>

      <TaskBox
        mode="project"
        param={{ orgId }}
        projectId={project.id}
        initialtasks={tasks}
      />
    </div>
  );
}
