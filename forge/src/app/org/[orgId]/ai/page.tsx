import { ChatWorkspace } from "@/features/organizations/components/ai/ChatWorkspace";

export default async function DiagnosticsPage({ params }: { params: Promise<{ orgId: string }> }) {
    const resolvedParams = await params;
  return (
    <div className="container mx-auto max-w-5xl py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-slate-900">Workspace Diagnostics</h1>
        <p className="text-slate-500 mt-2">
          Query your project data, task history, and organizational context using the RAG Engine.
        </p>
      </div>
      
      {/* Mount the Master Component Here */}
      <ChatWorkspace orgSlug={resolvedParams.orgId} />
    </div>
  );
}