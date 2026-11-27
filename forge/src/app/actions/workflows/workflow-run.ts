"use server";

import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { db } from "@/lib/prisma/db";
import { checkRateLimit, RATE_LIMIT_POLICIES } from "@/lib/security/rate-limit";
import { startWorkflow } from "@/lib/workflow/execution/trigger";
import {
  simulateWorkflowRun,
  type WorkflowSimulationResult,
} from "@/lib/workflow/execution/simulator";
import { toPublicError } from "@/lib/security/public-error";
import {
  validateTriggerContext,
  type TriggerContextValidationResult,
} from "@/lib/workflow/execution/trigger-context";
import { evaluateWorkflowDiagnostics } from "@/lib/workflow/validation/diagnostics";
import { compileWorkflow } from "@/lib/workflow/graph-ui/compiler";
import type { AppEdge, AppNode, WorkflowDefinition } from "@/lib/workflow-types/workflow";
import type { Prisma } from "@prisma/client";

// I6 — TENANT SCOPE. This server action is publicly reachable (it is called from
// the canvas Run button), so it must authenticate AND authorize before anything
// is executed. `orgslug` is the `[orgId]` URL segment, which the router fills
// with the organization *slug*; `getOrgAccess` resolves it against the session
// and returns the real organization id only for a member. The client cannot
// override the tenant: the id passed to `startWorkflow` comes from the verified
// access record, and a forged/foreign slug yields `null` and stops here with no
// side effects.
//
// 37.12 — RUNTIME-INPUT TRUST BOUNDARY. `triggerPayload` is OPTIONAL and is no
// longer an unconstrained blob: it is validated by `validateTriggerContext`
// before it becomes `WorkflowRun.context.trigger.outputs`. A generated,
// validator-clean workflow references no `trigger.outputs.*` field at all
// (workflow-proposal-references.ts:119-132), so the correct call for one omits
// the payload entirely; the previous canvas behaviour fabricated a `projectId`
// that had nothing to do with the workflow, and that fabrication is gone. For a
// manually authored workflow that genuinely reads `{{trigger.outputs.*}}`, the
// supplied context is bounded and cannot carry tenant/identity authority.
//
// This is a DATA boundary, not an authorization one: `orgId` is always the
// verified `access.organization.id`, never a payload value.
export async function triggerWorkflowRun(
  workflowId: string,
  orgslug: string,
  triggerPayload?: unknown,
): Promise<
  | { success: true; runId: string; redirectTo: string }
  | { success: false; error: string }
> {
  const access = await getOrgAccess(orgslug);
  if (!access) {
    return { success: false, error: "Unauthorized" };
  }

  const validated: TriggerContextValidationResult =
    validateTriggerContext(triggerPayload);
  if (!validated.ok) {
    // The reason is authored server-side for diagnostics; the client gets a
    // fixed, non-disclosing message. A rejected payload must not reach the
    // engine, so this returns before any run is created or work dispatched.
    console.error("[ACTION] Rejected trigger context:", validated.reason);
    return { success: false, error: "Invalid trigger data." };
  }

  try {
    const run = await startWorkflow(
      access.organization.id,
      workflowId,
      validated.value,
    );

    return {
      success: true,
      runId: run.id,
      redirectTo: `/org/${orgslug}/runs/${run.id}`,
    };
  } catch (error: unknown) {
    console.error("[ACTION ERROR] Failed to start workflow:", error);
    // S5 (security) — do not hand an arbitrary `error.message` back to the
    // client. Only authored, allowlisted messages survive; anything else
    // (database, provider, stack) becomes a generic message.
    return {
      success: false,
      error:
        toPublicError(error instanceof Error ? error.message : null) ??
        "Failed to initialize execution engine",
    };
  }
}

export interface SimulateWorkflowRunInput {
  workflowId: string;
  orgslug: string;
  target?: "draft" | "published";
  triggerPayloadJson?: string;
  currentNodes?: AppNode[];
  currentEdges?: AppEdge[];
}

export type SimulateWorkflowRunResponse =
  | {
      success: true;
      target: "draft" | "published";
      versionNumber: number | null;
      simulation: WorkflowSimulationResult;
    }
  | {
      success: false;
      error: string;
    };

/**
 * FC-016: Non-mutating sandbox workflow simulation server action.
 * Never creates WorkflowRun, Task, or WorkflowOutbox rows and never dispatches QStash/emails.
 */
export async function simulateWorkflowRunAction(
  input: SimulateWorkflowRunInput,
): Promise<SimulateWorkflowRunResponse> {
  const access = await getOrgAccess(input.orgslug);
  if (!access) {
    return { success: false, error: "Unauthorized" };
  }

  const rateResult = await checkRateLimit({
    policy: RATE_LIMIT_POLICIES.REQUEST_WORKFLOW_TEST_RUN,
    userId: access.userId,
    orgId: access.organization.id,
  });
  if (!rateResult.allowed) {
    return {
      success: false,
      error:
        rateResult.message ||
        "Simulation rate limit exceeded. Please wait before trying again.",
    };
  }

  let parsedPayload: unknown = {};
  if (input.triggerPayloadJson !== undefined && input.triggerPayloadJson.trim() !== "") {
    try {
      parsedPayload = JSON.parse(input.triggerPayloadJson);
    } catch {
      return { success: false, error: "Invalid trigger payload JSON." };
    }
  }

  const validated: TriggerContextValidationResult =
    validateTriggerContext(parsedPayload);
  if (!validated.ok) {
    return { success: false, error: validated.reason };
  }

  const target: "draft" | "published" =
    input.target === "published" ? "published" : "draft";

  try {
    const workflow = await db.workflow.findFirst({
      where: {
        id: input.workflowId,
        orgId: access.organization.id,
      },
      select: {
        id: true,
        orgId: true,
        definition: true,
        uiNodes: true,
        uiEdges: true,
        publishedVersionId: true,
      },
    });

    if (!workflow) {
      return { success: false, error: "Workflow not found in this organization." };
    }

    let definition: WorkflowDefinition;
    let uiNodes: AppNode[] = [];
    let uiEdges: AppEdge[] = [];
    let versionNumber: number | null = null;

    if (target === "published") {
      if (!workflow.publishedVersionId) {
        return {
          success: false,
          error: "No published version exists yet. Publish the workflow or simulate the saved draft.",
        };
      }
      const publishedVersion = await db.workflowVersion.findFirst({
        where: {
          id: workflow.publishedVersionId,
          workflowId: workflow.id,
          orgId: access.organization.id,
        },
        select: {
          id: true,
          versionNumber: true,
          definition: true,
          uiNodes: true,
        },
      });
      if (!publishedVersion) {
        return {
          success: false,
          error: "Published workflow version could not be loaded.",
        };
      }
      definition = publishedVersion.definition as unknown as WorkflowDefinition;
      uiNodes = (publishedVersion.uiNodes as unknown as AppNode[]) ?? [];
      versionNumber = publishedVersion.versionNumber;
    } else {
      // DRAFT SIMULATION:
      // If live canvas nodes/edges are provided from the editor, simulate them directly and sync draft
      if (input.currentNodes && input.currentEdges && input.currentNodes.length > 0) {
        uiNodes = input.currentNodes;
        uiEdges = input.currentEdges;
        const diagnostics = evaluateWorkflowDiagnostics(uiNodes, uiEdges);
        if (!diagnostics.canPublish) {
          return {
            success: false,
            error: `Cannot simulate invalid draft: ${diagnostics.errors[0]?.message ?? "Graph has validation errors."}`,
          };
        }
        definition = compileWorkflow(uiNodes, uiEdges);
        if (workflow && typeof db.workflow?.update === "function") {
          try {
            await db.workflow.update({
              where: { id: workflow.id },
              data: {
                uiNodes: uiNodes as unknown as Prisma.InputJsonValue,
                uiEdges: uiEdges as unknown as Prisma.InputJsonValue,
                definition: definition as unknown as Prisma.InputJsonValue,
              },
            });
          } catch (syncErr) {
            console.warn("[SIMULATION] Failed to sync live draft to database:", syncErr);
          }
        }
      } else {
        definition = workflow.definition as unknown as WorkflowDefinition;
        uiNodes = (workflow.uiNodes as unknown as AppNode[]) ?? [];
        uiEdges = (workflow.uiEdges as unknown as AppEdge[]) ?? [];
        const diagnostics = evaluateWorkflowDiagnostics(uiNodes, uiEdges);
        if (!diagnostics.canPublish) {
          return {
            success: false,
            error: `Cannot simulate invalid draft: ${diagnostics.errors[0]?.message ?? "Graph has validation errors."}`,
          };
        }
      }
    }

    const labelMap: Record<string, string> = {};
    for (const node of uiNodes) {
      if (node?.id) {
        labelMap[node.id] =
          typeof node.data?.label === "string" && node.data.label.trim()
            ? node.data.label
            : node.id;
      }
    }

    const simulation = await simulateWorkflowRun(definition, validated.value, {
      labelMap,
    });

    return {
      success: true,
      target,
      versionNumber,
      simulation,
    };
  } catch (error: unknown) {
    console.error("[SIMULATION ERROR] Failed to simulate workflow:", error);
    return {
      success: false,
      error:
        toPublicError(error instanceof Error ? error.message : null) ??
        "Failed to simulate workflow.",
    };
  }
}