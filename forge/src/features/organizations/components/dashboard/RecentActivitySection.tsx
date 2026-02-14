// RecentActivitySection.tsx
import { db } from "@/lib/prisma/db";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { notFound } from "next/navigation";

export default async function RecentActivitySection({
  orgSlug,
}: {
  orgSlug: string;
}) {
  const access = await getOrgAccess(orgSlug);
  if (!access) notFound();

  const orgId = access.organization.id;

  const recentTasks = await db.task.findMany({
    where: {
      project: { orgId },
    },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      title: true,
      createdAt: true,
    },
  });

  return (
    <div className="rounded-3xl border border-zinc-800/50 bg-zinc-900/20 p-8">
      <h3 className="text-lg font-semibold text-white mb-6">
        Recent Activity
      </h3>

      <div className="space-y-4">
        {recentTasks.length > 0 ? (
          recentTasks.map((task) => (
            <div
              key={task.id}
              className="flex items-center justify-between border-b border-zinc-800 pb-3"
            >
              <p className="text-zinc-300">{task.title}</p>
              <span className="text-zinc-500 text-xs">
                {new Date(task.createdAt).toLocaleDateString()}
              </span>
            </div>
          ))
        ) : (
          <p className="text-zinc-500 text-sm">
            No recent tasks found.
          </p>
        )}
      </div>
    </div>
  );
}
