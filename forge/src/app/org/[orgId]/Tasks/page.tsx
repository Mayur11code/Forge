import { auth } from "@/lib/auth/auth";
import { requireOrgAccess } from "@/features/organizations/require-org-access";
import TaskBox from "@/features/organizations/components/Taskbox";
import { db } from "@/lib/prisma/db";



export default async function TasksPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  // 🔐 Auth + org guard
  const { membership } = await requireOrgAccess(orgId);
  const session = await auth();

  const organization = await db.organization.findUnique({
    where: { slug: orgId },
  });

  if (!organization) {
    throw new Error("Organization not found");
  }

  // 📦 Fetch ALL tasks across ALL projects in this org
  const tasks = await db.task.findMany({
    where: {
      project: {
        orgId: organization.id,
      },
    },
    include: {
      project: {
        select: { id: true, name: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">All Tasks</h1>

      <p className="text-gray-600">
        Logged in as{" "}
        <span className="font-mono text-blue-500">
          {session?.user?.role}
        </span>
      </p>

      <TaskBox
        mode = "org"
        param={{ orgId }}
        initialtasks={tasks}
      />
    </div>
  );
}
