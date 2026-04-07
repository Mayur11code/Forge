import WorkflowBuilder from '@/features/organizations/components/workflow/WorkflowCanvas';
import { db } from '@/lib/prisma/db';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { AppNode, AppEdge } from '@/lib/workflow-types/workflow'; // Import types for nodes and edges
import { getOrgAccess } from '@/features/organizations/getOrgAccess';

export default async function EditWorkflowPage({ 
  params 
}: { 
  params: Promise<{ orgId: string, workflowId: string }> }) {
    const { orgId, workflowId } = await params; 
    const access = await getOrgAccess(orgId);
    if (!access) {
      return <div className="p-8 text-center text-red-500">Unauthorized</div>;
    }
  // 1. Fetch the exact workflow
  const workflow = await db.workflow.findUnique({
    where: { 
      id: workflowId,
      orgId: access.organization.id  // Security check to ensure cross-tenant isolation
    }
  });
console.log("Fetched workflow:", workflow);
  if (!workflow) return notFound();

  // 2. Cast the JSON from Prisma to our strict TypeScript types
  const nodes = (workflow.uiNodes as unknown) as AppNode[];
  const edges = (workflow.uiEdges as unknown) as AppEdge[];

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0a] text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-800 bg-[#0a0a0a] px-6 py-4">
        <div>
          <div className="flex items-center gap-2 text-sm text-zinc-400 mb-1">
            <Link href={`/org/${orgId}/workflows`} className="hover:text-zinc-200">Workflows</Link>
            <span>/</span>
            <span className="font-medium text-zinc-100">{workflow.name}</span>
          </div>
          <h1 className="text-2xl font-bold text-white">Edit Automation</h1>
        </div>
      </header>

      <main className="flex-1 overflow-hidden p-4">
        <div className="h-full w-full rounded-xl overflow-hidden">
          {/* 3. Pass the hydrated data into the client component */}
          <WorkflowBuilder 
            workflowId={workflow.id} 
            initialNodes={nodes} 
            initialEdges={edges} 
          />
        </div>
      </main>
    </div>
  );
}