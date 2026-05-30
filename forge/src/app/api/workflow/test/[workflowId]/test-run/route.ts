import { startWorkflow } 
from "@/lib/workflow/execution/trigger";

interface RouteContext {
  params: Promise<{
    workflowId: string;
  }>;
}

export async function POST(
  _req: Request,
  context: RouteContext
) {
  try {
    const { workflowId } =
      await context.params;

    console.log(
      `[TEST RUN] ${workflowId}`
    );

    const run =
      await startWorkflow(
        workflowId,
        {
          projectId:
            "cmnj8u44p0003a0gcvqgt25dv",
        }
      );

    return Response.json({
      runId: run.id,
      redirectTo:
        `/org/0d74fb33-0386-4c63-8f96-c2bd1496c055/runs/${run.id}`,
    });
  } catch (error) {
  console.error(
    "TEST RUN ERROR",
    error
  );

  return Response.json(
    {
      error:
        error instanceof Error
          ? error.message
          : "Unknown error",
      stack:
        process.env.NODE_ENV ===
        "development"
          ? (
              error as Error
            )?.stack
          : undefined,
    },
    {
      status: 500,
    }
  )}}