// src/app/org/[orgId]/dashboard/page.tsx

import { Activity, LayoutGrid, Users, Zap } from "lucide-react";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { notFound } from "next/navigation";
import { db } from "@/lib/prisma/db";
import PriorityChart from "@/features/organizations/components/dashboard/PriorityChart";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  // 1️⃣ Authenticate user and verify org access
  const access = await getOrgAccess(orgId);
  if (!access) notFound();

  const organization = access.organization;
  const userId = access.userId;

  // 2️⃣ Parallel Aggregations (Performance Layer)
  const [
    totalProjects,
    totalTasks,
    assignedToMe,
    completedTasks,
    activeMembers,
    recentTasks,
    tasksByPriorityRaw,
  ] = await Promise.all([
    db.project.count({
      where: { orgId: organization.id },
    }),

    db.task.count({
      where: {
        project: { orgId: organization.id },
      },
    }),

    db.task.count({
      where: {
        assigneeId: userId,
        project: { orgId: organization.id },
      },
    }),

    db.task.count({
      where: {
        status: "DONE",
        project: { orgId: organization.id },
      },
    }),

    db.membership.count({
      where: { orgId: organization.id },
    }),

    db.task.findMany({
      where: {
        project: { orgId: organization.id },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        title: true,
        createdAt: true,

        
      },
      
    }),

    db.task.groupBy({
  by: ["priority"],
  where: {
    project: { orgId: organization.id },
  },
  _count: {
    priority: true,
  },
})


  ]);

  // 3️⃣ Replace mock stats with real data
  const stats = [
    {
      label: "Total Projects",
      value: totalProjects,
      icon: LayoutGrid,
      color: "text-blue-500",
      bg: "bg-blue-500/10",
    },
    {
      label: "Total Tasks",
      value: totalTasks,
      icon: Zap,
      color: "text-amber-500",
      bg: "bg-amber-500/10",
    },
    {
      label: "Assigned To Me",
      value: assignedToMe,
      icon: Users,
      color: "text-emerald-500",
      bg: "bg-emerald-500/10",
    },
    {
      label: "Completed Tasks",
      value: completedTasks,
      icon: Activity,
      color: "text-purple-500",
      bg: "bg-purple-500/10",
    },
  ];

  const priorityMap = {
  LOW: 0,
  MEDIUM: 0,
  HIGH: 0,
};

tasksByPriorityRaw.forEach((item) => {
  priorityMap[item.priority] = item._count.priority;
});

const chartData = [
  { name: "Low", value: priorityMap.LOW },
  { name: "Medium", value: priorityMap.MEDIUM },
  { name: "High", value: priorityMap.HIGH },
];


  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-700">
      {/* Welcome Header */}
      <div className="flex flex-col gap-1">
        <h2 className="text-3xl font-bold tracking-tight text-white">
          Dashboard Overview
        </h2>
        <p className="text-zinc-400 flex items-center gap-2 text-sm">
          Analytics and insights for
          <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-blue-500/10 border border-blue-500/20 font-mono text-blue-400 text-xs">
            {orgId}
          </span>
        </p>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {stats.map((stat, index) => {
          const Icon = stat.icon;
          return (
            <div
              key={index}
              className="relative overflow-hidden group p-6 rounded-2xl bg-zinc-900/40 border border-zinc-800/50 hover:border-zinc-700/50 transition-all duration-300 backdrop-blur-sm"
            >
              {/* Background Accent Glow */}
              <div
                className={`absolute -right-4 -top-4 w-24 h-24 rounded-full blur-3xl opacity-10 transition-opacity group-hover:opacity-20 ${stat.bg}`}
              />

              <div className="flex items-center justify-between mb-4">
                <div className={`p-2 rounded-lg ${stat.bg} ${stat.color}`}>
                  <Icon className="w-5 h-5" />
                </div>

                {/* Static growth badge (visual only) */}
                <div className="flex items-center gap-1 text-[10px] font-bold text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-full uppercase tracking-tighter">
                  <Activity className="w-3 h-3" />
                  LIVE
                </div>
              </div>

              <div className="space-y-1">
                <p className="text-zinc-500 text-xs font-bold uppercase tracking-widest">
                  {stat.label}
                </p>
                <h3 className="text-3xl font-bold text-zinc-100 tabular-nums">
                  {stat.value}
                </h3>
              </div>
            </div>
          );
        })}
      </div>
{/* Tasks by Priority Chart */}
<div className="rounded-3xl border border-zinc-800/50 bg-zinc-900/20 p-8">
  <h3 className="text-lg font-semibold text-white mb-6">
    Tasks by Priority
  </h3>

  <PriorityChart data={chartData} />
</div>

      {/* Recent Activity */}
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
    </div>
  );
}
