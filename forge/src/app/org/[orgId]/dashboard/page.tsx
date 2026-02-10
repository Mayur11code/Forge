// src/app/org/[orgId]/dashboard/page.tsx
import { mockTasks } from "@/features/tasks/mockData";
// import { requireOrgAccess } from "../../../../features/organizations/require-org-access";
import { Activity, LayoutGrid, Users, Zap } from "lucide-react"; // Icons for metrics
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { notFound } from "next/navigation";

export default async function DashboardPage({ 
  params 
}: { 
  params: Promise<{ orgId: string }> 
}) {
  const { orgId } = await params;

  // Logic remains the same, but we prepare data for the UI
  const stats = [
    { label: "Total Tasks", value: mockTasks.length, icon: LayoutGrid, color: "text-blue-500", bg: "bg-blue-500/10" },
    { label: "Active Members", value: "12", icon: Users, color: "text-emerald-500", bg: "bg-emerald-500/10" },
    { label: "Events Logged", value: "124", icon: Zap, color: "text-amber-500", bg: "bg-amber-500/10" },
  ];

  // 1️⃣ Authenticate user and verify org access
    // const { organization, membership } = await requireOrgAccess(orgId);
     const access = await getOrgAccess(orgId );
    if (!access) notFound();
    const organization = access.organization;
    console.log("Organization in Dashboard Page:", organization);


  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-700">
      {/* Welcome Header */}
      <div className="flex flex-col gap-1">
        <h2 className="text-3xl font-bold tracking-tight text-white">Dashboard Overview</h2>
        <p className="text-zinc-400 flex items-center gap-2 text-sm">
          Analytics and insights for 
          <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-blue-500/10 border border-blue-500/20 font-mono text-blue-400 text-xs">
            {orgId}
          </span>
        </p>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {stats.map((stat, index) => {
          const Icon = stat.icon;
          return (
            <div 
              key={index}
              className="relative overflow-hidden group p-6 rounded-2xl bg-zinc-900/40 border border-zinc-800/50 hover:border-zinc-700/50 transition-all duration-300 backdrop-blur-sm"
            >
              {/* Background Accent Glow */}
              <div className={`absolute -right-4 -top-4 w-24 h-24 rounded-full blur-3xl opacity-10 transition-opacity group-hover:opacity-20 ${stat.bg}`} />

              <div className="flex items-center justify-between mb-4">
                <div className={`p-2 rounded-lg ${stat.bg} ${stat.color}`}>
                  <Icon className="w-5 h-5" />
                </div>
                <div className="flex items-center gap-1 text-[10px] font-bold text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-full uppercase tracking-tighter">
                  <Activity className="w-3 h-3" />
                  +12%
                </div>
              </div>

              <div className="space-y-1">
                <p className="text-zinc-500 text-xs font-bold uppercase tracking-widest">{stat.label}</p>
                <h3 className="text-3xl font-bold text-zinc-100 tabular-nums">{stat.value}</h3>
              </div>
            </div>
          );
        })}
      </div>

      {/* Visual Placeholder for a Chart/Activity Feed */}
      <div className="rounded-3xl border border-zinc-800/50 bg-zinc-900/20 p-8 h-64 flex flex-col items-center justify-center border-dashed">
        <div className="p-4 rounded-full bg-zinc-800/50 mb-4">
          <Activity className="w-8 h-8 text-zinc-600" />
        </div>
        <p className="text-zinc-500 font-medium">Activity graph will appear here</p>
        <p className="text-zinc-600 text-sm">Connected to real-time events stream</p>
      </div>
    </div>
  );
}