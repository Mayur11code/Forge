'use server';

import { db } from '@/lib/prisma/db'; 
import { revalidatePath } from 'next/cache';
import { getOrgAccess } from '@/features/organizations/getOrgAccess';
import { z } from 'zod';
import { TriggerNodeDataSchema, ActionNodeDataSchema } from '@/lib/workflow-types/workflow';

// Import the compiler we just built!
import { compileWorkflow } from '@/lib/workflow/graph-ui/compiler';
import { WorkflowValidationError } from '@/lib/workflow-types/workflow';

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

const IncomingNodeSchema = z.object({
  id: z.string(),
  type: z.enum(['trigger', 'action']),
  position: z.object({ x: z.number(), y: z.number() }),
  data: z.discriminatedUnion('type', [
    z.object({ type: z.literal('trigger') }).merge(TriggerNodeDataSchema),
    z.object({ type: z.literal('action') }).merge(ActionNodeDataSchema)
  ]).optional().or(z.any()),
});

// ------------------------------------------------------------------
// CREATE WORKFLOW
// ------------------------------------------------------------------
export async function saveWorkflowState(
  orgslug: string, 
  name: string,
  uiNodes: any[], 
  uiEdges: any[]
) {
  try {
    const access = await getOrgAccess(orgslug);
    if (!access) return { success: false, error: "Unauthorized" };

    const areNodesValid = z.array(IncomingNodeSchema).safeParse(uiNodes); 
    if (!areNodesValid.success) return { success: false, error: "Malformed workflow data." };

    const orgId = access.organization.id;

    // --- THE COMPILER INJECTION ---
    const compiledDefinition = compileWorkflow(uiNodes, uiEdges);
    
    // Find the trigger to extract the global event ID
    const triggerNode = uiNodes.find(n => n.type === 'trigger');
    const eventId = triggerNode?.data?.eventId || null;

    const workflow = await db.workflow.create({
      data: {
        name,
        orgId,
        uiNodes: uiNodes, 
        uiEdges: uiEdges,
        // Inject the compiled DAG!
        definition: compiledDefinition, 
        // Sync the DB schema with the trigger configuration
        eventId: eventId,
        isActive: !!eventId, // Only active if a trigger is actually set
      }
    });

    revalidatePath(`/org/${orgId}/workflows`);
    return { success: true, workflowId: workflow.id };
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
  uiNodes: any[], 
  uiEdges: any[]
) {
  try {
    const access = await getOrgAccess(orgslug);
    if (!access) return { success: false, error: "Unauthorized" };

    const areNodesValid = z.array(z.any()).safeParse(uiNodes); 
    if (!areNodesValid.success) return { success: false, error: "Malformed workflow data." };

    // --- THE COMPILER INJECTION ---
    
    const compiledDefinition = compileWorkflow(uiNodes, uiEdges);
    
    const triggerNode = uiNodes.find(n => n.type === 'trigger');
    const eventId = triggerNode?.data?.eventId || null;

    await db.workflow.update({
      where: { id: workflowId },
      data: {
        uiNodes, 
        uiEdges,
        // Update the DAG on every save!
        definition: compiledDefinition,
        eventId: eventId,
        isActive: !!eventId,
      }
    });

    revalidatePath(`/org/${access.organization.id}/workflows/${workflowId}`);
    return { success: true };
  } catch (error) {
    const compileError = describeCompileFailure(error);
    if (compileError) {
      return { success: false, error: compileError };
    }

    console.error("Failed to update workflow:", error);
    return { success: false, error: "Failed to update workflow." };
  }
}
