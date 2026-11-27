'use server';

import { z } from 'zod';
import { db } from '@/lib/prisma/db'; 
import { revalidatePath } from 'next/cache';
import { getOrgAccess } from '@/features/organizations/getOrgAccess';

// Import the compiler we just built!
import { compileWorkflow } from '@/lib/workflow/graph-ui/compiler';
import { WorkflowValidationError } from '@/lib/workflow-types/workflow';
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
) {
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
        isActive: !!eventId, // Only active if a trigger is actually set
      }
    });

    revalidatePath(`/org/${orgslug}/workflows`);
    revalidatePath(`/org/${orgId}/workflows`);
    return {
      success: true,
      workflowId: workflow.id,
      name: parsedName.data,
      description: normalizedDescription,
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
) {
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
      select: { id: true },
    });

    if (!existing) {
      return { success: false, error: "Workflow not found in this organization." };
    }

    const { count } = await db.workflow.updateMany({
      where: {
        id: workflowId,
        orgId: access.organization.id,
      },
      data: {
        ...(validatedName !== undefined ? { name: validatedName } : {}),
        ...(validatedDescription !== undefined ? { description: validatedDescription } : {}),
        uiNodes: validNodes, 
        uiEdges: validEdges,
        // Update the DAG on every save!
        definition: compiledDefinition,
        eventId: eventId,
        isActive: !!eventId,
      }
    });

    if (count === 0) {
      return { success: false, error: "Workflow not found in this organization." };
    }

    revalidatePath(`/org/${orgslug}/workflows`);
    revalidatePath(`/org/${orgslug}/workflows/${workflowId}`);
    revalidatePath(`/org/${access.organization.id}/workflows/${workflowId}`);
    return {
      success: true,
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
