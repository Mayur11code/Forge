'use server';

import { z } from 'zod';
import { db } from '@/lib/prisma/db'; 
import { revalidatePath } from 'next/cache';
import { getOrgAccess } from '@/features/organizations/getOrgAccess';
import type { Prisma } from '@prisma/client';

// Import the compiler we just built!
import { compileWorkflow } from '@/lib/workflow/graph-ui/compiler';
import { WorkflowValidationError, type AppEdge, type AppNode } from '@/lib/workflow-types/workflow';
import { evaluateWorkflowDiagnostics, type WorkflowDiagnostic } from '@/lib/workflow/validation/diagnostics';
import { computeWorkflowDefinitionHash } from '@/lib/workflow/validation/canonical-hash';
import { ActionRegistry } from '@/lib/workflow-types/action-registry';
// The persistence-boundary schemas live in one shared module (Assignment 37.11)
// so the proposal materializer validates against the same contract this save
// path does, rather than a second, weaker copy.
import {
  IncomingNodesSchema,
  IncomingEdgesSchema,
  type IncomingNode,
} from '@/lib/workflow/validation/incoming-graph';

const WorkflowNameSchema = z
  .string()
  .trim()
  .min(1, "Workflow name is required.")
  .max(100, "Workflow name must be at most 100 characters.");

const WorkflowDescriptionSchema = z
  .string()
  .trim()
  .max(500, "Workflow description must be at most 500 characters.")
  .nullable()
  .optional();

export type WorkflowMetadataInput = {
  name?: string;
  description?: string | null;
  expectedDraftRevision?: number;
};

function normalizeDescription(
  raw: string | null | undefined,
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Turn a compile failure into something the user can act on.
 *
 * Without this the validation in `compileWorkflow` is still correct, but the
 * user is told "Failed to save workflow to database" for what is a problem with
 * the graph they drew - which reads as the app being broken and sends them to
 * the wrong place entirely. Returns null when the failure was something else, so
 * the caller's generic handling takes over.
 */
function describeCompileFailure(error: unknown): string | null {
  if (!(error instanceof WorkflowValidationError)) {
    return null;
  }

  return error.issues.map((issue) => issue.message).join(' ');
}

// ------------------------------------------------------------------
// CREATE WORKFLOW
// ------------------------------------------------------------------
export async function saveWorkflowState(
  orgslug: string, 
  name: string,
  uiNodes: unknown[], 
  uiEdges: unknown[],
  description?: string | null,
): Promise<
  | {
      success: true;
      workflowId: string;
      name: string;
      description: string | null;
      draftRevision: number;
    }
  | {
      success: false;
      error: string;
    }
> {
  try {
    const access = await getOrgAccess(orgslug);
    if (!access) return { success: false, error: "Unauthorized" };

    const parsedName = WorkflowNameSchema.safeParse(name);
    if (!parsedName.success) {
      return {
        success: false,
        error: parsedName.error.issues[0]?.message || "Invalid workflow name.",
      };
    }

    const parsedDescription = WorkflowDescriptionSchema.safeParse(description);
    if (!parsedDescription.success) {
      return {
        success: false,
        error: parsedDescription.error.issues[0]?.message || "Invalid workflow description.",
      };
    }

    const areNodesValid = IncomingNodesSchema.safeParse(uiNodes); 
    if (!areNodesValid.success) return { success: false, error: "Malformed workflow data." };

    const areEdgesValid = IncomingEdgesSchema.safeParse(uiEdges);
    if (!areEdgesValid.success) return { success: false, error: "Malformed workflow data." };

    // Compile and persist what was validated, not the raw argument. Persisting
    // the input while validating a copy would leave unvalidated keys in the row
    // and make the check advisory rather than binding.
    const validNodes: IncomingNode[] = areNodesValid.data;
    const validEdges = areEdgesValid.data;

    const orgId = access.organization.id;

    // --- THE COMPILER INJECTION ---
    const compiledDefinition = compileWorkflow(validNodes, validEdges);
    
    // Find the trigger to extract the global event ID
    const triggerNode = validNodes.find(n => n.type === 'trigger');
    const eventId = triggerNode?.data?.eventId || null;
    const normalizedDescription = normalizeDescription(parsedDescription.data) ?? null;

    const workflow = await db.workflow.create({
      data: {
        name: parsedName.data,
        description: normalizedDescription,
        orgId,
        uiNodes: validNodes, 
        uiEdges: validEdges,
        // Inject the compiled DAG!
        definition: compiledDefinition, 
        // Sync the DB schema with the trigger configuration
        eventId: eventId,
        // FC-015: New drafts are never published or active until explicitly published.
        isActive: false,
        draftRevision: 1,
        publishedVersionId: null,
      }
    });

    revalidatePath(`/org/${orgslug}/workflows`);
    revalidatePath(`/org/${orgId}/workflows`);
    return {
      success: true,
      workflowId: workflow.id,
      name: parsedName.data,
      description: normalizedDescription,
      draftRevision: 1,
    };
  } catch (error) {
    const compileError = describeCompileFailure(error);
    if (compileError) {
      return { success: false, error: compileError };
    }

    console.error("Failed to save workflow:", error);
    return { success: false, error: "Failed to save workflow to database." };
  }
}

// ------------------------------------------------------------------
// UPDATE WORKFLOW
// ------------------------------------------------------------------
export async function updateWorkflowState(
  orgslug: string,
  workflowId: string, 
  uiNodes: unknown[], 
  uiEdges: unknown[],
  metadata?: WorkflowMetadataInput,
): Promise<
  | {
      success: true;
      draftRevision: number;
      name?: string;
      description?: string | null;
    }
  | {
      success: false;
      error: string;
    }
> {
  try {
    const access = await getOrgAccess(orgslug);
    if (!access) return { success: false, error: "Unauthorized" };

    let validatedName: string | undefined;
    if (metadata?.name !== undefined) {
      const parsedName = WorkflowNameSchema.safeParse(metadata.name);
      if (!parsedName.success) {
        return {
          success: false,
          error: parsedName.error.issues[0]?.message || "Invalid workflow name.",
        };
      }
      validatedName = parsedName.data;
    }

    let validatedDescription: string | null | undefined;
    if (metadata?.description !== undefined) {
      const parsedDescription = WorkflowDescriptionSchema.safeParse(metadata.description);
      if (!parsedDescription.success) {
        return {
          success: false,
          error:
            parsedDescription.error.issues[0]?.message || "Invalid workflow description.",
        };
      }
      validatedDescription = normalizeDescription(parsedDescription.data);
    }

    const areNodesValid = IncomingNodesSchema.safeParse(uiNodes); 
    if (!areNodesValid.success) return { success: false, error: "Malformed workflow data." };

    const areEdgesValid = IncomingEdgesSchema.safeParse(uiEdges);
    if (!areEdgesValid.success) return { success: false, error: "Malformed workflow data." };

    const validNodes: IncomingNode[] = areNodesValid.data;
    const validEdges = areEdgesValid.data;

    // --- THE COMPILER INJECTION ---
    const compiledDefinition = compileWorkflow(validNodes, validEdges);
    
    const triggerNode = validNodes.find(n => n.type === 'trigger');
    const eventId = triggerNode?.data?.eventId || null;

    // Tenancy rides in the write predicate, not in a check beside it.
    const existing = await db.workflow.findFirst({
      where: { id: workflowId, orgId: access.organization.id },
      select: { id: true, draftRevision: true },
    });

    if (!existing) {
      return { success: false, error: "Workflow not found in this organization." };
    }

    if (
      metadata?.expectedDraftRevision !== undefined &&
      existing.draftRevision !== undefined &&
      existing.draftRevision !== metadata.expectedDraftRevision
    ) {
      return {
        success: false,
        error:
          "Workflow draft was modified in another session. Refresh to load the latest draft.",
      };
    }

    const { count } = await db.workflow.updateMany({
      where: {
        id: workflowId,
        orgId: access.organization.id,
        ...(metadata?.expectedDraftRevision !== undefined
          ? { draftRevision: metadata.expectedDraftRevision }
          : {}),
      },
      data: {
        ...(validatedName !== undefined ? { name: validatedName } : {}),
        ...(validatedDescription !== undefined ? { description: validatedDescription } : {}),
        uiNodes: validNodes, 
        uiEdges: validEdges,
        // Update the draft DAG on save without altering publishedVersionId or isActive!
        definition: compiledDefinition,
        eventId: eventId,
        draftRevision: { increment: 1 },
      }
    });

    if (count === 0) {
      if (metadata?.expectedDraftRevision !== undefined) {
        return {
          success: false,
          error:
            "Workflow draft was modified in another session. Refresh to load the latest draft.",
        };
      }
      return { success: false, error: "Workflow not found in this organization." };
    }

    const nextDraftRevision =
      typeof existing.draftRevision === "number" ? existing.draftRevision + 1 : 2;

    revalidatePath(`/org/${orgslug}/workflows`);
    revalidatePath(`/org/${orgslug}/workflows/${workflowId}`);
    revalidatePath(`/org/${access.organization.id}/workflows/${workflowId}`);
    return {
      success: true,
      draftRevision: nextDraftRevision,
      ...(validatedName !== undefined ? { name: validatedName } : {}),
      ...(validatedDescription !== undefined ? { description: validatedDescription } : {}),
    };
  } catch (error) {
    const compileError = describeCompileFailure(error);
    if (compileError) {
      return { success: false, error: compileError };
    }

    console.error("Failed to update workflow:", error);
    return { success: false, error: "Failed to update workflow." };
  }
}

// ------------------------------------------------------------------
// PUBLISH WORKFLOW (FC-015)
// ------------------------------------------------------------------
export async function publishWorkflowAction(
  orgslug: string,
  workflowId: string,
): Promise<
  | {
      success: true;
      versionId: string;
      versionNumber: number;
      definitionHash: string;
      isActive: true;
    }
  | {
      success: false;
      error: string;
      issues?: WorkflowDiagnostic[];
    }
> {
  try {
    const access = await getOrgAccess(orgslug);
    if (!access) return { success: false, error: "Unauthorized" };

    const orgId = access.organization.id;
    const publishedById = access.userId;

    const executeInTx = async <T>(
      fn: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<T>,
    ): Promise<T> => {
      if (typeof db.$transaction === "function") {
        return db.$transaction(fn, { maxWait: 10000, timeout: 20000 });
      }
      return fn(db);
    };

    const txResult = await executeInTx(async (tx) => {
      // 1. Lock the authoritative Workflow row inside the transaction
      let workflow: {
        id: string;
        orgId: string;
        name: string;
        description: string | null;
        uiNodes: unknown;
        uiEdges: unknown;
        eventId: string | null;
      } | null = null;

      if (typeof tx.$queryRaw === "function") {
        try {
          const rows = await tx.$queryRaw<
            Array<{
              id: string;
              orgId: string;
              name: string;
              description: string | null;
              uiNodes: unknown;
              uiEdges: unknown;
              eventId: string | null;
            }>
          >`
            SELECT id, "orgId", name, description, "uiNodes", "uiEdges", "eventId"
            FROM "Workflow"
            WHERE id = ${workflowId} AND "orgId" = ${orgId}
            FOR UPDATE
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
          select: {
            id: true,
            orgId: true,
            name: true,
            description: true,
            uiNodes: true,
            uiEdges: true,
            eventId: true,
          },
        });
      }

      if (!workflow) {
        return {
          success: false as const,
          error: "Workflow not found in this organization.",
        };
      }

      // 2. Validate persisted draft nodes/edges
      const areNodesValid = IncomingNodesSchema.safeParse(workflow.uiNodes);
      const areEdgesValid = IncomingEdgesSchema.safeParse(workflow.uiEdges);
      if (!areNodesValid.success || !areEdgesValid.success) {
        return {
          success: false as const,
          error: "Saved workflow draft contains malformed nodes or edges.",
        };
      }

      const validNodes = areNodesValid.data as AppNode[];
      const validEdges = areEdgesValid.data as AppEdge[];

      // 3. Authoritative server-side FC-014 publish validation
      const registeredActionIds = new Set(Object.keys(ActionRegistry));
      const diagnostics = evaluateWorkflowDiagnostics(validNodes, validEdges, {
        registeredActionIds,
      });

      if (!diagnostics.canPublish) {
        return {
          success: false as const,
          error:
            diagnostics.errors[0]?.message ||
            "Workflow has validation errors and cannot be published.",
          issues: diagnostics.errors,
        };
      }

      // 4. Compile & hash canonical definition
      const compiledDefinition = compileWorkflow(validNodes, validEdges);
      const definitionHash = computeWorkflowDefinitionHash({
        snapshotSchemaVersion: 1,
        workflowId: workflow.id,
        workflowName: workflow.name,
        definition: compiledDefinition,
        actionManifest: [],
        createdAt: "published-version",
      });

      const triggerNode = validNodes.find((n) => n.type === "trigger");
      const eventId =
        triggerNode?.type === "trigger" ? triggerNode.data.eventId : workflow.eventId;

      // 5. Monotonic version number under Workflow FOR UPDATE lock
      const latestVersion = await tx.workflowVersion.findFirst({
        where: { workflowId: workflow.id, orgId },
        orderBy: { versionNumber: "desc" },
        select: { versionNumber: true },
      });
      const nextVersionNumber = (latestVersion?.versionNumber ?? 0) + 1;

      const createdVersion = await tx.workflowVersion.create({
        data: {
          workflowId: workflow.id,
          orgId,
          versionNumber: nextVersionNumber,
          name: workflow.name,
          description: workflow.description ?? null,
          eventId: eventId ?? null,
          uiNodes: validNodes as unknown as Prisma.InputJsonValue,
          uiEdges: validEdges as unknown as Prisma.InputJsonValue,
          definition: compiledDefinition as unknown as Prisma.InputJsonValue,
          definitionHash,
          publishedById,
        },
      });

      const { count } = await tx.workflow.updateMany({
        where: { id: workflow.id, orgId },
        data: {
          publishedVersionId: createdVersion.id,
          isActive: true,
          eventId: eventId ?? null,
        },
      });

      if (count === 0) {
        throw new Error("Workflow not found in this organization.");
      }

      return {
        success: true as const,
        versionId: createdVersion.id,
        versionNumber: nextVersionNumber,
        definitionHash,
        isActive: true as const,
      };
    });

    if (txResult.success) {
      revalidatePath(`/org/${orgslug}/workflows`);
      revalidatePath(`/org/${orgslug}/workflows/${workflowId}`);
    }

    return txResult;
  } catch (error) {
    const compileError = describeCompileFailure(error);
    if (compileError) {
      return { success: false, error: compileError };
    }
    console.error("Failed to publish workflow:", error);
    return { success: false, error: "Failed to publish workflow." };
  }
}

// ------------------------------------------------------------------
// ACTIVATE / SUSPEND PUBLISHED WORKFLOW (FC-015)
// ------------------------------------------------------------------
export async function toggleWorkflowActiveAction(
  orgslug: string,
  workflowId: string,
  isActive: boolean,
): Promise<{ success: true; isActive: boolean } | { success: false; error: string }> {
  try {
    const access = await getOrgAccess(orgslug);
    if (!access) return { success: false, error: "Unauthorized" };

    const orgId = access.organization.id;

    const existing = await db.workflow.findFirst({
      where: { id: workflowId, orgId },
      select: { id: true, publishedVersionId: true },
    });

    if (!existing) {
      return { success: false, error: "Workflow not found in this organization." };
    }

    if (isActive && !existing.publishedVersionId) {
      return {
        success: false,
        error: "Publish a workflow version before activating it.",
      };
    }

    const { count } = await db.workflow.updateMany({
      where: { id: workflowId, orgId },
      data: { isActive },
    });

    if (count === 0) {
      return { success: false, error: "Workflow not found in this organization." };
    }

    revalidatePath(`/org/${orgslug}/workflows`);
    revalidatePath(`/org/${orgslug}/workflows/${workflowId}`);
    return { success: true, isActive };
  } catch (error) {
    console.error("Failed to toggle workflow active state:", error);
    return { success: false, error: "Failed to update workflow active state." };
  }
}
