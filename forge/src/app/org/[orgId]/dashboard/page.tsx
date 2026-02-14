// src/app/org/[orgId]/dashboard/page.tsx

import { Suspense } from "react";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { notFound } from "next/navigation";

import StatsSection from "@/features/organizations/components/dashboard/StatsSection";
import PrioritySection from "@/features/organizations/components/dashboard/PrioritySection";
import RecentActivitySection from "@/features/organizations/components/dashboard/RecentActivitySection";

import StatsSkeleton from "@/features/organizations/components/dashboard/StatsSkeleton";
import ChartSkeleton from "@/features/organizations/components/dashboard/ChartSkeleton";
import RecentSkeleton from "@/features/organizations/components/dashboard/RecentSkeleton";

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  const access = await getOrgAccess(orgId);
  if (!access) notFound();

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-700">
      
      {/* Header renders immediately */}
      <div className="flex flex-col gap-1">
        <h2 className="text-3xl font-bold tracking-tight text-white">
          Dashboard Overview
        </h2>
        <p className="text-zinc-400 text-sm">
          Analytics and insights for{" "}
          <span className="text-blue-400 font-mono">
            {orgId}
          </span>
        </p>
      </div>

      {/* Stats */}
      <Suspense fallback={<StatsSkeleton />}>
        <StatsSection orgSlug={orgId} />
      </Suspense>

      {/* Chart */}
      <Suspense fallback={<ChartSkeleton />}>
        <PrioritySection orgSlug={orgId} />
      </Suspense>

      {/* Recent Activity */}
      <Suspense fallback={<RecentSkeleton />}>
        <RecentActivitySection orgSlug={orgId} />
      </Suspense>

    </div>
  );
}
