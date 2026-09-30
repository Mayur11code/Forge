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

/**
 * Node validation at the persistence boundary.
 *
 * `data` used to be `.optional().or(z.any())`. `z.any()` accepts every value,
 * including `undefined`, so the union's right-hand branch always succeeded and
 * the left-hand branch was never reached: `eventId`, `actionType`, `config` and
 * `isCritical` - everything that decides what executes - crossed the boundary
 * unchecked.
 *
 * The union discriminates on the node's own `type`, not on `data.type`. React
 * Flow carries the discriminator at the top level and `AppNode`'s inferred data
 * type has no `type` field, so a union keyed on `data.type` would reject every
 * node this application actually creates. Keying it on `node.type` also makes
 * the two impossible to disagree: a node typed `trigger` must carry trigger data,
 * with no cross-field refinement needed to notice when it does not.
 */
const IncomingNodeSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string(),
    type: z.literal('trigger'),
    position: z.object({ x: z.number(), y: z.number() }),
    data: TriggerNodeDataSchema,
  }),
  z.object({
    id: z.string(),
    type: z.literal('action'),
    position: z.object({ x: z.number(), y: z.number() }),
    data: ActionNodeDataSchema,
  }),
]);

const IncomingNodesSchema = z.array(IncomingNodeSchema);

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

    const areNodesValid = IncomingNodesSchema.safeParse(uiNodes); 
    if (!areNodesValid.success) return { success: false, error: "Malformed workflow data." };

    // Compile and persist what was validated, not the raw argument. Persisting
    // the input while validating a copy would leave unvalidated keys in the row
    // and make the check advisory rather than binding.
    const validNodes = areNodesValid.data;

    const orgId = access.organization.id;

    // --- THE COMPILER INJECTION ---
    const compiledDefinition = compileWorkflow(validNodes, uiEdges);
    
    // Find the trigger to extract the global event ID
    const triggerNode = validNodes.find(n => n.type === 'trigger');
    const eventId = triggerNode?.data?.eventId || null;

    const workflow = await db.workflow.create({
      data: {
        name,
        orgId,
        uiNodes: validNodes, 
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

    const areNodesValid = IncomingNodesSchema.safeParse(uiNodes); 
    if (!areNodesValid.success) return { success: false, error: "Malformed workflow data." };

    const validNodes = areNodesValid.data;

    // --- THE COMPILER INJECTION ---
    
    const compiledDefinition = compileWorkflow(validNodes, uiEdges);
    
    const triggerNode = validNodes.find(n => n.type === 'trigger');
    const eventId = triggerNode?.data?.eventId || null;

    // Tenancy rides in the write predicate, not in a check beside it. The old
    // predicate was `{ id: workflowId }`, so `getOrgAccess` above proved
    // membership in an org the update then ignored - any authenticated member of
    // any org could overwrite any workflow by id.
    const existing = await db.workflow.findFirst({
      where: { id: workflowId, orgId: access.organization.id },
      select: { id: true },
    });

    // A workflow owned by another org is indistinguishable from one that does
    // not exist, and both refuse before any write is issued. A distinct response
    // for each would turn this endpoint into an existence oracle for other
    // tenants' workflow ids.
    if (!existing) {
      return { success: false, error: "Workflow not found in this organization." };
    }

    const { count } = await db.workflow.updateMany({
      where: {
        id: workflowId,
        orgId: access.organization.id,
      },
      data: {
        uiNodes: validNodes, 
        uiEdges,
        // Update the DAG on every save!
        definition: compiledDefinition,
        eventId: eventId,
        isActive: !!eventId,
      }
    });

    // The refusal above already established the tenant, but the write carries
    // the same constraint so the two can never disagree. If the row moved orgs or
    // disappeared between the two statements this matches nothing, and the
    // response is unchanged rather than a cross-tenant write.
    if (count === 0) {
      return { success: false, error: "Workflow not found in this organization." };
    }

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
