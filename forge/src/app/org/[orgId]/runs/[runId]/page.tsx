import { notFound } from "next/navigation";
import { db } from "@/lib/prisma/db";
import type {
  AppNode,
  AppEdge,
} from "@/lib/workflow-types/workflow";
import WorkflowRunDashboard from "@/features/organizations/components/workflow/WorkflowRunDashboard";

interface RunPageProps {
  params: Promise<{
    orgId: string;
    runId: string;
  }>;
}





export default async function WorkflowRunPage({
  params
}: RunPageProps) {
 const { runId, orgId } = await params;

  // Fetch workflow run + graph
const run = await db.workflowRun.findFirst({
  where: {
    id: runId,
    workflow: {
      organization: {
        slug: orgId,
      },
    },
  },
  include: {
    workflow: true,
    stepRuns: true,
  },
});

  if (!run) {
    console.log(`Run ${runId} not found for org ${orgId}`);
    notFound();
  }

  // Original graph layout
const rawNodes =
  (run.workflow.uiNodes as unknown as AppNode[]) ?? [];

const rawEdges =
  (run.workflow.uiEdges as unknown as AppEdge[]) ?? [];

  // O(1) lookup
  const statusMap = new Map(
    run.stepRuns.map((sr) => [
      sr.stepId,
      sr.status,
    ])
  );



const hydratedNodes = rawNodes.map(
  <T extends AppNode>(node: T): T => {
    const executionStatus = statusMap.get(node.id);

    if (!executionStatus) {
      return node;
    }

    return {
      ...node,
      data: {
        ...node.data,
        executionStatus,
      },
    };
  }
);

  return (
    <div className="flex h-screen w-full bg-[#09090B] text-zinc-100 overflow-hidden">
     
      {/* MAIN GRAPH */}
      <main className="relative flex-1 overflow-hidden">
        {/* TOP GLASS BAR */}
        <div className="absolute left-0 right-0 top-0 z-10 border-b border-zinc-800 bg-zinc-950/70 backdrop-blur-xl">
          <div className="flex items-center justify-between px-8 py-4">
            <div>
              <h2 className="text-sm font-medium text-zinc-300">
                Live Workflow Graph
              </h2>

              <p className="text-xs text-zinc-500">
                Real-time execution
                visualization
              </p>
            </div>

            <div className="rounded-full border border-zinc-800 bg-zinc-900 px-4 py-2 text-xs text-zinc-400">
              {rawEdges.length} edges
            </div>
          </div>
        </div>

        {/* REACT FLOW */}
        <div className="h-full pt-[72px]">
          <WorkflowRunDashboard
            runId={run.id}
            initialNodes={hydratedNodes}
            initialEdges={rawEdges}
            initialStatus={run.status}
          />
        </div>
      </main>
    </div>
  );
}