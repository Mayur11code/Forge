import WorkflowBuilder from '@/features/organizations/components/workflow/WorkflowCanvas';
import Link from 'next/link';

export default async function NewWorkflowPage({ params }: { params: Promise<{ orgId: string }> }) {

    const {orgId} = await params;
  return (
    // Changed bg-gray-50 to a deep dark background
    <div className="flex flex-col h-screen bg-[#0a0a0a] text-zinc-100">
      
      {/* Dark Header */}
      <header className="flex items-center justify-between border-b border-black bg-[#0a0a0a] px-6 py-4">
        <div>
          <div className="flex items-center gap-2 text-sm text-zinc-400 mb-1">
            <Link href={`/org/${orgId}`} className="hover:text-zinc-200">Dashboard</Link>
            <span>/</span>
            <Link href={`/org/${orgId}/workflows`} className="hover:text-zinc-200">Workflows</Link>
            <span>/</span>
            <span className="font-medium text-zinc-100">New Builder</span>
          </div>
          <h1 className="text-2xl font-bold text-white">Automation Builder</h1>
        </div>

        
      </header>

      {/* Main Canvas Area */}
      <main className="flex-1 overflow-hidden p-4">
        
          <WorkflowBuilder />
       
      </main>

    </div>
  );
}