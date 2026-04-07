import { db } from '@/lib/prisma/db';
import Link from 'next/link';
import { Zap, Settings2, ArrowRight } from 'lucide-react';
import { getOrgAccess } from '@/features/organizations/getOrgAccess';

export default async function WorkflowsDashboard({ params }: { params: Promise<{ orgId: string }>}) {
 
 const access = await getOrgAccess((await params).orgId);
 if (!access) {
  // Handle unauthorized access, e.g., redirect or show an error message
  return <div className="p-8 text-center text-red-500">Unauthorized</div>;
 }
    const { orgId } = await params;
  
    // 1. Fetch all workflows for this tenant from the database
  const workflows = await db.workflow.findMany({
    where: { orgId: access.organization.id },
    orderBy: { createdAt: 'desc' }
  });

  return (
    <div className="p-8 max-w-6xl mx-auto h-screen bg-[#0a0a0a] text-zinc-100">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold text-white">Automations</h1>
          <p className="text-zinc-400 mt-1">Manage your event-driven workflows.</p>
        </div>
        <Link 
          href={`/org/${orgId}/workflows/new`}
          className="bg-blue-600 hover:bg-blue-500 text-white px-5 py-2.5 rounded-lg font-semibold transition-colors flex items-center gap-2"
        >
          <Zap size={16} />
          Create Workflow
        </Link>
      </div>

      {/* 2. The Grid of Saved DAGs */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {workflows.length === 0 ? (
          <div className="col-span-full p-8 border border-zinc-800 border-dashed rounded-xl text-center text-zinc-500">
            No workflows built yet. Click "Create Workflow" to get started.
          </div>
        ) : (
          workflows.map((wf) => (
            <Link 
              key={wf.id} 
              href={`/org/${orgId}/workflows/${wf.id}`} // Links to the edit page!
              className="block p-5 border border-zinc-800 bg-[#121212] rounded-xl hover:border-blue-500/50 transition-colors group"
            >
              <div className="flex justify-between items-start mb-4">
                <div className="p-2 bg-blue-500/10 rounded-lg text-blue-400">
                  <Settings2 size={20} />
                </div>
                <span className={`text-xs px-2 py-1 rounded-full border ${wf.isActive ? 'border-emerald-500/30 text-emerald-400 bg-emerald-500/10' : 'border-zinc-700 text-zinc-500 bg-zinc-800/50'}`}>
                  {wf.isActive ? 'Active' : 'Draft'}
                </span>
              </div>
              <h3 className="font-bold text-lg text-white mb-1 group-hover:text-blue-400 transition-colors">
                {wf.name}
              </h3>
              <p className="text-sm text-zinc-500 mb-4">
                ID: <span className="font-mono text-xs">{wf.id.slice(0, 8)}...</span>
              </p>
              <div className="text-sm text-blue-500 font-medium flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                Edit Canvas <ArrowRight size={14} />
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}