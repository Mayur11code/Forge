// PrioritySection.tsx
import { db } from "@/lib/prisma/db";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { notFound } from "next/navigation";
import PriorityChart from "./PriorityChart";

export default async function PrioritySection({
  orgSlug,
}: {
  orgSlug: string;
}) {
  const access = await getOrgAccess(orgSlug);
  if (!access) notFound();

  const orgId = access.organization.id;

  const raw = await db.task.groupBy({
    by: ["priority"],
    where: {
      project: { orgId },
    },
    _count: {
      priority: true,
    },
  });

  const priorityMap = {
    LOW: 0,
    MEDIUM: 0,
    HIGH: 0,
  };

  raw.forEach((item) => {
    priorityMap[item.priority] = item._count.priority;
  });

  const chartData = [
    { name: "Low", value: priorityMap.LOW },
    { name: "Medium", value: priorityMap.MEDIUM },
    { name: "High", value: priorityMap.HIGH },
  ];

  return (
    <div className="rounded-3xl border border-zinc-800/50 bg-zinc-900/20 p-8">
      <h3 className="text-lg font-semibold text-white mb-6">
        Tasks by Priority
      </h3>

      <PriorityChart data={chartData} />
    </div>
  );
}
