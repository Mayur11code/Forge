import { auth } from "@/lib/auth/auth";
import { db } from "@/lib/prisma/db";
import { notFound } from "next/navigation";
import TaskBox from "@/features/organizations/components/TaskBox";
import { requireOrgAccess } from "@/features/organizations/require-org-access";

export default async function ProjectTasksPage({
  params,
}: {
  params: Promise< { orgId: string; projectId: string }>;
}) {
  const { orgId, projectId } = await params;

  // 1️⃣ Org access (RBAC boundary)
  await requireOrgAccess(orgId);

  // 1. Fetch the organization using the slug from the URL
const organization = await db.organization.findUnique({
  where: { slug: orgId } // assuming 'orgId' variable holds 'forge-hq'
});

if(organization === null){return notFound();}

  // 2️⃣ Fetch project + tasks (scoped!)
  const project = await db.project.findFirst({
    where: {
      id: projectId,
      orgId :organization?.id,
    },
    include: {
      tasks: {
        orderBy: { createdAt: "asc" },
      },
    },
  });
  
  if (!project) {
      console.log("id mismatch");
    return notFound();
  }

  console.log("🚀 PROJECT TASKS PAGE - Project:", project.name, "with", project.tasks.length, "tasks.");
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{project.name}</h1>
      <p className="text-gray-500">{project.description}</p>

      <TaskBox
        param={{ orgId }}
        projectId={project.id}
        initialtasks={project.tasks}
      />
    </div>
  );
}
