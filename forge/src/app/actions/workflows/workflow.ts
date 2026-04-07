'use server';

import { db } from '@/lib/prisma/db'; // Adjust this import based on where your prisma client lives
import { revalidatePath } from 'next/cache';
import { getOrgAccess } from '@/features/organizations/getOrgAccess';
import OrgLayout from '@/app/org/[orgId]/layout';
import { z } from 'zod';
import { TriggerNodeDataSchema } from '@/lib/workflow-types/workflow';
import { ActionNodeDataSchema } from '@/lib/workflow-types/workflow';
// 1. Create a schema to validate the incoming UI Arrays
const IncomingNodeSchema = z.object({
  id: z.string(),
  type: z.enum(['trigger', 'action']),
  position: z.object({ x: z.number(), y: z.number() }),
  // Validate the payload based on the node type
  data: z.discriminatedUnion('type', [
    z.object({ type: z.literal('trigger') }).merge(TriggerNodeDataSchema),
    z.object({ type: z.literal('action') }).merge(ActionNodeDataSchema)
  ]).optional().or(z.any()), // Simplified for example, but you get the idea!
});


export async function saveWorkflowState(
  orgslug: string, 
  name: string,
  uiNodes: any[], 
  uiEdges: any[]
) {
  try {
    // 1. In a real app, you'd check auth here (e.g., const session = await auth();)
    const access = await getOrgAccess(orgslug);
    if (!access) {
      return { success: false, error: "Unauthorized" };
    }

    const areNodesValid = z.array(z.any()).safeParse(uiNodes); // Replace z.any() with strict schema in production
    
    if (!areNodesValid.success) {
      return { success: false, error: "Malformed workflow data. Save rejected." };
    }

    const orgId = access.organization.id;
    // 2. Save to PostgreSQL via Prisma
    const workflow = await db.workflow.create({
      data: {
        name,
        orgId,
        // Prisma will automatically serialize these arrays into JSONB for Postgres
        uiNodes: uiNodes, 
        uiEdges: uiEdges,
        // We leave definition empty for now. Assignment 26 will compile the DAG here!
        definition: {}, 
        isActive: false,
      }
    });

    // 3. Clear the Next.js cache so the dashboard updates
    revalidatePath(`/org/${orgId}/workflows`);

    return { success: true, workflowId: workflow.id };
  } catch (error) {
    console.error("Failed to save workflow:", error);
    return { success: false, error: "Failed to save workflow to database." };
  }
}

// This function is for updating an existing workflow's UI state (nodes and edges) as the user edits it.
export async function updateWorkflowState(
Orgslug: string,
  workflowId: string, 
  uiNodes: any[], 
  uiEdges: any[]
) {
  try {

const access = await getOrgAccess(Orgslug);
if (!access) {
  return { success: false, error: "Unauthorized" };
}
const areNodesValid = z.array(z.any()).safeParse(uiNodes); // Replace z.any() with strict schema in production
    
    if (!areNodesValid.success) {
      return { success: false, error: "Malformed workflow data. Save rejected." };
    }
    await db.workflow.update({
      where: { id: workflowId },
      data: {
        uiNodes, 
        uiEdges,
      }
    });

    revalidatePath(`/org/[orgId]/workflows/${workflowId}`, 'page');
    return { success: true };
  } catch (error) {
    console.error("Failed to update workflow:", error);
    return { success: false, error: "Failed to update workflow." };
  }
}