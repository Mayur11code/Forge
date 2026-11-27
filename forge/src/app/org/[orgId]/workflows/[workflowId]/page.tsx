import WorkflowBuilder from '@/features/organizations/components/workflow/WorkflowCanvas';
import { db } from '@/lib/prisma/db';
import { notFound } from 'next/navigation';
import type { AppNode, AppEdge } from '@/lib/workflow-types/workflow';
import { getOrgAccess } from '@/features/organizations/getOrgAccess';

export default async function EditWorkflowPage({ 
  params 
}: { 
  params: Promise<{ orgId: string, workflowId: string }> }) {
  const { orgId, workflowId } = await params; 
  const access = await getOrgAccess(orgId);
  if (!access) {
    return <div className="p-8 text-center text-red-500 font-mono">Unauthorized</div>;
  }

  // 1. Fetch exact workflow
  const workflow = await db.workflow.findUnique({
    where: { 
      id: workflowId,
      orgId: access.organization.id
    },
    include: {
      publishedVersion: {
        select: {
          id: true,
          versionNumber: true,
          definitionHash: true,
        },
      },
    },
  });
  if (!workflow) return notFound();

  // 2. Cast JSON from Prisma to strict TypeScript types
  const nodes = (workflow.uiNodes as unknown) as AppNode[];
  const edges = (workflow.uiEdges as unknown) as AppEdge[];

  return (
    <div className="flex-1 flex flex-col h-full w-full overflow-hidden bg-[#07070a] relative">
      <WorkflowBuilder 
        workflowId={workflow.id} 
        initialName={workflow.name}
        initialDescription={workflow.description}
        initialNodes={nodes} 
        initialEdges={edges}
        initialDraftRevision={workflow.draftRevision}
        initialPublishedVersionNumber={workflow.publishedVersion?.versionNumber ?? null}
        initialIsActive={workflow.isActive}
      />
    </div>
  );
}
