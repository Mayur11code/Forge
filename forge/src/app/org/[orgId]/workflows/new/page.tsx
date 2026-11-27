import WorkflowBuilder from '@/features/organizations/components/workflow/WorkflowCanvas';

export default async function NewWorkflowPage({ params }: { params: Promise<{ orgId: string }> }) {
  await params;
  return (
    <div className="flex-1 flex flex-col h-full w-full overflow-hidden bg-[#07070a] relative">
      <WorkflowBuilder />
    </div>
  );
}
