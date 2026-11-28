// src/lib/workflow/execution/trigger.ts
import { db } from "@/lib/prisma/db";
import { advanceWorkflow } from "./evaluator";
import type { JsonValue } from "@/lib/workflow-types/type";
import type { Prisma, WorkflowRun } from "@prisma/client";
import { WorkflowDefinitionSchema } from "@/lib/workflow-types/workflow";
import { getRegisteredActionForIgnition } from "@/lib/workflow-types/action-registry";
import { AVAILABLE_TRIGGERS } from "@/lib/workflow-types/registry";
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
export interface StartWorkflowOptions {
  expectedVersionId?: string;
  dispatchId?: string;
}

export async function startWorkflow(
  orgId: string,
  workflowId: string,
  triggerData: Record<string, JsonValue> = {},
  options?: StartWorkflowOptions,
): Promise<WorkflowRun> {
  const executeInTransaction = async <T>(
    fn: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<T>,
  ): Promise<T> => {
    if (typeof db.$transaction === "function") {
      return db.$transaction(fn, { timeout: 15000, maxWait: 10000 });
    }
    return fn(db);
  };

  const { run, workflowName, definitionHash, isRecovered } = await executeInTransaction(async (tx) => {
    // 1. ATOMIC WORKFLOW ROW LOCK (FOR SHARE on PostgreSQL)
    let workflow: {
      id: string;
      orgId: string;
      name: string;
      definition: unknown;
      isActive?: boolean;
      publishedVersionId?: string | null;
    } | null = null;
    if (typeof tx.$queryRaw === "function") {
      try {
        const rows = await tx.$queryRaw<
          Array<{
            id: string;
            orgId: string;
            name: string;
            definition: unknown;
            isActive: boolean;
            publishedVersionId: string | null;
          }>
        >`
          SELECT id, "orgId", name, definition, "isActive", "publishedVersionId"
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

    // FC-015: Live execution requires an active, published workflow version.
    // Draft-only rows (publishedVersionId === null) and inactive workflows
    // (isActive === false) fail closed before any run or outbox intent is created.
    if (workflow.publishedVersionId === null) {
      throw new Error("Cannot start workflow: workflow has not been published.");
    }
    if (workflow.isActive === false) {
      throw new Error("Cannot start workflow: workflow is currently inactive.");
    }

    // Publication race protection: if an expected version ID was specified, assert it still matches!
    if (options?.expectedVersionId && workflow.publishedVersionId !== options.expectedVersionId) {
      throw new Error(
        `Cannot start workflow: expected version ${options.expectedVersionId} but current published version is ${workflow.publishedVersionId}.`,
      );
    }

    // M4-REM-2: Atomic Dispatch Ledger Claim & Redelivery Recovery (Section 3.3)
    if (options?.dispatchId) {
      // 0.1 Check for already STARTED dispatch (recovery of existing run)
      const dispatch = await (tx as unknown as {
        workflowTriggerDispatch: {
          findUnique: (args: unknown) => Promise<{ id: string; status: string; runId: string | null } | null>;
        };
      }).workflowTriggerDispatch.findUnique({
        where: { id: options.dispatchId },
      });

      if (!dispatch) {
        throw new Error(`Cannot start workflow: dispatch ${options.dispatchId} not found.`);
      }

      if (dispatch.status === "STARTED" && dispatch.runId) {
        const existingRun = await tx.workflowRun.findUnique({
          where: { id: dispatch.runId },
        });
        if (existingRun) {
          return { run: existingRun, workflowName: workflow.name, definitionHash: existingRun.definitionHash || "", isRecovered: true };
        }
      }

      // 0.2 Atomically claim ignition right: transition PENDING -> PROCESSING
      const claimResult = await (tx as unknown as {
        workflowTriggerDispatch: {
          updateMany: (args: unknown) => Promise<{ count: number }>;
        };
      }).workflowTriggerDispatch.updateMany({
        where: {
          id: options.dispatchId,
          status: "PENDING",
          runId: null,
        },
        data: {
          status: "PROCESSING",
        },
      });

      if (claimResult.count === 0) {
        // Another concurrent worker claimed the dispatch or it transitioned in the race.
        // Check if winning worker already completed ignition:
        const recheck = await (tx as unknown as {
          workflowTriggerDispatch: {
            findUnique: (args: unknown) => Promise<{ id: string; status: string; runId: string | null } | null>;
          };
        }).workflowTriggerDispatch.findUnique({
          where: { id: options.dispatchId },
        });

        if (recheck?.status === "STARTED" && recheck.runId) {
          const existingRun = await tx.workflowRun.findUnique({
            where: { id: recheck.runId },
          });
          if (existingRun) {
            return { run: existingRun, workflowName: workflow.name, definitionHash: existingRun.definitionHash || "", isRecovered: true };
          }
        }

        // Losing worker: abort BEFORE creating any WorkflowRun row!
        throw new Error("DISPATCH_ALREADY_CLAIMED_OR_STARTED");
      }
    }

    let executionName = workflow.name;
    let rawDefinition = workflow.definition;
    let resolvedVersionId: string | null = null;

    if (typeof workflow.publishedVersionId === "string" && workflow.publishedVersionId.length > 0) {
      const version = await tx.workflowVersion.findFirst({
        where: {
          id: workflow.publishedVersionId,
          workflowId: workflow.id,
          orgId,
        },
        select: { id: true, name: true, definition: true },
      });
      if (!version) {
        throw new Error("Cannot start workflow: published workflow version not found.");
      }
      executionName = version.name;
      rawDefinition = version.definition;
      resolvedVersionId = version.id;
    }

    // 2. VALIDATE DEFINITION AT IGNITION
    const parsedDefinition = WorkflowDefinitionSchema.safeParse(rawDefinition);
    if (!parsedDefinition.success) {
      throw new Error(
        `Cannot start workflow: definition is invalid: ${parsedDefinition.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      );
    }
    const definition = parsedDefinition.data;

    // 3. VALIDATE TRIGGERS & BUILD ACTION MANIFEST WITH PINNED VERSIONS
    // TRIGGER steps are validated against AVAILABLE_TRIGGERS and retain no-op
    // trigger-context semantics in wrapper.ts; only ACTION steps belong in the
    // executable actionManifest.
    const knownTriggerIds = new Set(AVAILABLE_TRIGGERS.map((t) => t.id));
    const actionManifest: WorkflowActionManifestEntry[] = [];
    for (const [stepId, step] of Object.entries(definition.steps)) {
      if (step.kind === "TRIGGER") {
        if (!knownTriggerIds.has(step.action)) {
          throw new Error(
            `Cannot start workflow: trigger step "${stepId}" has unknown trigger "${step.action}"`,
          );
        }
        continue;
      }

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
      workflowName: executionName,
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
        ...(resolvedVersionId ? { workflowVersionId: resolvedVersionId } : {}),
        status: "RUNNING",
        context: initialContext,
        definitionSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        definitionHash: hash,
      },
    });

    // Atomically link created run to WorkflowTriggerDispatch ledger if ignition is event-driven
    // Concurrency Invariant (M4-REM-2): transition PROCESSING -> STARTED with runId
    if (options?.dispatchId) {
      await (tx as unknown as {
        workflowTriggerDispatch: {
          updateMany: (args: unknown) => Promise<{ count: number }>;
        };
      }).workflowTriggerDispatch.updateMany({
        where: {
          id: options.dispatchId,
          status: "PROCESSING",
          runId: null,
        },
        data: {
          runId: createdRun.id,
          status: "STARTED",
        },
      });
    }

    return { run: createdRun, workflowName: executionName, definitionHash: hash, isRecovered: false };
  });

  console.log(`[IGNITION] Started WorkflowRun ${run.id} for Workflow ${workflowName} (hash: ${definitionHash})`);

  // 8. PUSH THE FIRST DOMINO (POST-COMMIT) - Only advance newly started runs
  if (!isRecovered) {
    await advanceWorkflow(run.id);
  }

  return run;
}
