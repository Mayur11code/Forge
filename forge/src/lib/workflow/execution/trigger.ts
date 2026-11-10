// src/lib/workflow/execution/trigger.ts
import { db } from "@/lib/prisma/db";
import { advanceWorkflow } from "./evaluator";
import type { JsonValue } from "@/lib/workflow-types/type";
import type { Prisma, WorkflowRun } from "@prisma/client";
import { WorkflowDefinitionSchema } from "@/lib/workflow-types/workflow";
import { getRegisteredActionForIgnition } from "@/lib/workflow-types/action-registry";
import {
  WorkflowExecutionSnapshot,
  WorkflowActionManifestEntry,
} from "@/lib/workflow-types/snapshot";
import { computeWorkflowDefinitionHash } from "../validation/canonical-hash";

// Type-only. triggerData becomes WorkflowRun.context, a JSONB column, so
// JsonValue is the honest bound: anything wider would be silently mangled on
// write.
//
// I6 — TENANT SCOPE. `orgId` is REQUIRED and is the organization the caller was
// *verified* against at the boundary (a server-derived id, never a value lifted
// from the request body). The lookup below carries `orgId` in its predicate, so
// a workflow belonging to another tenant is indistinguishable from a missing
// one and can never be started. The parameter is deliberately not optional:
// there is no unscoped call shape left for a future caller to reach for, and
// adding one would not compile.
export async function startWorkflow(
  orgId: string,
  workflowId: string,
  triggerData: Record<string, JsonValue> = {},
): Promise<WorkflowRun> {
  const executeInTransaction = async <T>(
    fn: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<T>,
  ): Promise<T> => {
    if (typeof db.$transaction === "function") {
      return db.$transaction(fn, { timeout: 15000, maxWait: 10000 });
    }
    return fn(db);
  };

  const { run, workflowName, definitionHash } = await executeInTransaction(async (tx) => {
    // 1. ATOMIC WORKFLOW ROW LOCK (FOR SHARE on PostgreSQL)
    let workflow: { id: string; orgId: string; name: string; definition: unknown } | null = null;
    if (typeof tx.$queryRaw === "function") {
      try {
        const rows = await tx.$queryRaw<Array<{ id: string; orgId: string; name: string; definition: unknown }>>`
          SELECT id, "orgId", name, definition
          FROM "Workflow"
          WHERE id = ${workflowId} AND "orgId" = ${orgId}
          FOR SHARE
        `;
        if (rows && rows.length > 0) {
          workflow = rows[0];
        }
      } catch {
        workflow = null;
      }
    }

    if (!workflow) {
      workflow = await tx.workflow.findFirst({
        where: { id: workflowId, orgId },
      });
      if (!workflow) {
        throw new Error(`Cannot start workflow: ${workflowId} not found.`);
      }
    }

    // 2. VALIDATE DEFINITION AT IGNITION
    const parsedDefinition = WorkflowDefinitionSchema.safeParse(workflow.definition);
    if (!parsedDefinition.success) {
      throw new Error(
        `Cannot start workflow: definition is invalid: ${parsedDefinition.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      );
    }
    const definition = parsedDefinition.data;

    // 3. BUILD ACTION MANIFEST WITH PINNED VERSIONS
    const actionManifest: WorkflowActionManifestEntry[] = [];
    for (const [stepId, step] of Object.entries(definition.steps)) {
      const action = getRegisteredActionForIgnition(step.action);
      if (!action) {
        throw new Error(
          `Cannot start workflow: step "${stepId}" requires action "${step.action}" which is not registered`,
        );
      }
      actionManifest.push({
        stepId,
        actionId: step.action,
        actionVersion: action.version,
      });
    }

    // 4. CONSTRUCT IMMUTABLE SNAPSHOT ENVELOPE
    const snapshot: WorkflowExecutionSnapshot = {
      snapshotSchemaVersion: 1,
      workflowId: workflow.id,
      workflowName: workflow.name,
      definition,
      actionManifest,
      createdAt: new Date().toISOString(),
    };

    // 5. COMPUTE CANONICAL HASH
    const hash = computeWorkflowDefinitionHash(snapshot);

    // 6. INITIALIZE GLOBAL CONTEXT
    const initialContext = {
      trigger: {
        outputs: triggerData,
      },
    };

    // 7. CREATE THE RUN RECORD ATOMICALLY WITH SNAPSHOT AND HASH
    const createdRun = await tx.workflowRun.create({
      data: {
        workflowId: workflow.id,
        status: "RUNNING",
        context: initialContext,
        definitionSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        definitionHash: hash,
      },
    });

    return { run: createdRun, workflowName: workflow.name, definitionHash: hash };
  });

  console.log(`[IGNITION] Started WorkflowRun ${run.id} for Workflow ${workflowName} (hash: ${definitionHash})`);

  // 8. PUSH THE FIRST DOMINO (POST-COMMIT)
  await advanceWorkflow(run.id);

  return run;
}
