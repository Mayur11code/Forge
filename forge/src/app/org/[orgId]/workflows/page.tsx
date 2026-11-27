import { db } from '@/lib/prisma/db';
import Link from 'next/link';
import { Plus, Workflow, ArrowRight, Activity } from 'lucide-react';
import { getOrgAccess } from '@/features/organizations/getOrgAccess';

export default async function WorkflowsDashboard({ params }: { params: Promise<{ orgId: string }>}) {
  const { orgId } = await params;
  const access = await getOrgAccess(orgId);
  if (!access) {
    return <div className="p-8 text-center text-rose-500 font-mono">Unauthorized</div>;
  }

  // 1. Fetch all workflows for this tenant from the database
  const workflows = await db.workflow.findMany({
    where: { orgId: access.organization.id },
    orderBy: { createdAt: 'desc' },
    include: {
      publishedVersion: {
        select: {
          versionNumber: true,
        },
      },
    },
  });

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/[0.08] pb-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-white">Automations</h1>
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-white/[0.06] border border-white/[0.1] text-zinc-300">
              [ {workflows.length} DAG{workflows.length === 1 ? '' : 's'} ]
            </span>
          </div>
          <p className="text-xs font-mono text-zinc-400">
            Construct, simulate, and publish event-driven DAG workflows.
          </p>
        </div>

        <Link 
          href={`/org/${orgId}/workflows/new`}
          className="inline-flex items-center gap-2 rounded-xl bg-zinc-100 hover:bg-white text-zinc-950 px-4 py-2.5 text-xs font-mono font-bold tracking-wider shadow-[0_4px_20px_rgba(255,255,255,0.15)] transition-all hover:-translate-y-0.5 active:translate-y-0 shrink-0"
        >
          <Plus size={15} className="text-zinc-950" />
          <span>Create Workflow</span>
        </Link>
      </div>

      {/* Grid of Saved DAGs */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {workflows.length === 0 ? (
          <div className="col-span-full py-16 px-6 border border-white/[0.08] border-dashed rounded-2xl text-center space-y-3 bg-[#0a0a10]/40">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-white/[0.1] bg-white/[0.04] text-zinc-400 mx-auto">
              <Workflow size={22} />
            </div>
            <h3 className="text-sm font-mono font-bold text-zinc-200">No workflows authored yet</h3>
            <p className="text-xs font-mono text-zinc-500 max-w-sm mx-auto">
              Construct visual orchestrations with triggers, action blades, and transactional sagas.
            </p>
            <div className="pt-2">
              <Link
                href={`/org/${orgId}/workflows/new`}
                className="inline-flex items-center gap-1.5 text-xs font-mono font-semibold text-zinc-200 hover:text-white transition-colors"
              >
                <span>Launch Canvas Editor</span>
                <ArrowRight size={13} />
              </Link>
            </div>
          </div>
        ) : (
          workflows.map((wf) => (
            <Link 
              key={wf.id} 
              href={`/org/${orgId}/workflows/${wf.id}`}
              className="group block rounded-2xl border border-white/[0.08] bg-[#0c0c14]/90 p-5 hover:border-white/[0.22] hover:bg-[#10101a] transition-all duration-200 shadow-[0_8px_30px_rgba(0,0,0,0.5)] hover:-translate-y-0.5 relative overflow-hidden"
            >
              {/* Card Header */}
              <div className="flex items-center justify-between gap-2 mb-4">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/[0.04] border border-white/[0.1] text-zinc-300 group-hover:text-white group-hover:border-white/20 transition-all">
                  <Workflow size={17} />
                </div>
                <span
                  className={`text-[10px] font-mono font-medium px-2.5 py-0.5 rounded-full border flex items-center gap-1.5 ${
                    wf.publishedVersion
                      ? wf.isActive
                        ? 'border-white/20 text-zinc-100 bg-white/[0.08] shadow-[0_0_10px_rgba(255,255,255,0.06)]'
                        : 'border-zinc-700 text-zinc-400 bg-zinc-800/40'
                      : 'border-white/[0.1] text-zinc-400 bg-white/[0.04]'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      wf.publishedVersion && wf.isActive
                        ? 'bg-white animate-pulse shadow-[0_0_8px_rgba(255,255,255,0.7)]'
                        : wf.publishedVersion
                        ? 'bg-zinc-500'
                        : 'bg-zinc-600'
                    }`}
                  />
                  <span>
                    {wf.publishedVersion
                      ? `v${wf.publishedVersion.versionNumber} · ${wf.isActive ? 'Active' : 'Paused'}`
                      : 'Draft'}
                  </span>
                </span>
              </div>

              {/* Title & Description */}
              <h3 className="font-semibold text-base text-zinc-100 group-hover:text-white transition-colors truncate mb-1">
                {wf.name}
              </h3>
              <p className="text-xs text-zinc-400 font-mono line-clamp-2 h-8 leading-relaxed mb-4">
                {wf.description || 'No description provided.'}
              </p>

              {/* Footer */}
              <div className="flex items-center justify-between pt-3 border-t border-white/[0.06] text-xs font-mono">
                <span className="text-[10px] text-zinc-500 truncate max-w-[140px]">
                  ID: {wf.id.slice(0, 10)}...
                </span>
                <span className="text-zinc-400 group-hover:text-white group-hover:translate-x-0.5 transition-all flex items-center gap-1 text-[11px] font-semibold">
                  <span>Open</span>
                  <ArrowRight size={12} />
                </span>
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
