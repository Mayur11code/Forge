// StatsSection.tsx
import { db } from "@/lib/prisma/db";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { notFound } from "next/navigation";
import { Activity, LayoutGrid, Users, Zap } from "lucide-react";

export default async function StatsSection({
  orgSlug,
}: {
  orgSlug: string;
}) {
  const access = await getOrgAccess(orgSlug);
  if (!access) notFound();

  const orgId = access.organization.id;
  const userId = access.userId;

  const [
    totalProjects,
    totalTasks,
    assignedToMe,
    completedTasks,
  ] = await Promise.all([
    db.project.count({ where: { orgId } }),

    db.task.count({
      where: { project: { orgId } },
    }),

    db.task.count({
      where: {
        assigneeId: userId,
        project: { orgId },
      },
    }),

    db.task.count({
      where: {
        status: "DONE",
        project: { orgId },
      },
    }),
  ]);

  const stats = [
    { label: "Total Projects", value: totalProjects, icon: LayoutGrid },
    { label: "Total Tasks", value: totalTasks, icon: Zap },
    { label: "Assigned To Me", value: assignedToMe, icon: Users },
    { label: "Completed Tasks", value: completedTasks, icon: Activity },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
      {stats.map((stat, index) => {
        const Icon = stat.icon;

        return (
          <div
            key={index}
            className="p-6 rounded-2xl bg-zinc-900/40 border border-zinc-800/50 backdrop-blur-sm"
          >
            <div className="flex items-center justify-between mb-4">
              <Icon className="w-5 h-5 text-zinc-400" />
              <span className="text-[10px] font-bold text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-full uppercase">
                LIVE
              </span>
            </div>

            <p className="text-zinc-500 text-xs uppercase tracking-widest">
              {stat.label}
            </p>

            <h3 className="text-3xl font-bold text-zinc-100 tabular-nums">
              {stat.value}
            </h3>
          </div>
        );
      })}
    </div>
  );
}
