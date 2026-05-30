import { z } from 'zod';
import type { Node, Edge } from '@xyflow/react';
import { StepExecutionStatus } from '@prisma/client';

const ExecutionStatusSchema = z
  .enum(StepExecutionStatus)
  .optional();

// ------------------------------------------------------------------
// 1. THE EXECUTION BLUEPRINT (Zod Validation)
// This validates the `definition` column in your Prisma database.
// ------------------------------------------------------------------

export const WorkflowStepSchema = z.object({
  id: z.string(),
  action: z.string(), 
  dependsOn: z.array(z.string()), 
  
  // --- PHASE 6: IF/ELSE ROUTING ---
  // Tells the engine which branch this node sits on
  routingConditions: z.record(z.string(), z.string()).optional(),

  // --- PHASE 6: SAGA FLAG ---
  // Tells the engine if a failure here should trigger a rollback
  isCritical: z.boolean().optional().default(false), 

  kind: z.enum([
     "TRIGGER",
     "ACTION",
   ]),

  
  config: z.record(z.string(), z.any()).optional().default({}), 
});

export const WorkflowDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  // A record where the key is the step ID, and the value is the step object
  steps: z.record(z.string(), WorkflowStepSchema),
});

// 🔥 MAGIC TRICK: Automatically infer TypeScript types from Zod schemas!
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;


// ------------------------------------------------------------------
// 2. FRONTEND UI PAYLOADS (Zod Validation)
// Validates the `data` object inside your React Flow nodes.
// ------------------------------------------------------------------

export const TriggerNodeDataSchema = z.object({
  label: z.string(),
  eventId: z.string().nullable(), 

  executionStatus: ExecutionStatusSchema, // This will be injected live during execution to reflect the current status of the step
});

export const ActionNodeDataSchema = z.object({
  label: z.string(),
  actionType: z.string(), 
  config: z.record(z.string(), z.any()).default({}),
  isConfigured: z.boolean().default(false),
  isCritical: z.boolean().default(false),

  executionStatus: ExecutionStatusSchema, // This will be injected live during execution to reflect the current status of the step
});

export type TriggerNodeData = z.infer<typeof TriggerNodeDataSchema>;
export type ActionNodeData = z.infer<typeof ActionNodeDataSchema>;

// Create specific types for the FULL nodes
export type TriggerNodeType = Node<TriggerNodeData, 'trigger'>;
export type ActionNodeType = Node<ActionNodeData, 'action'>;

// Now AppNode is a union of those full nodes
export type AppNode = TriggerNodeType | ActionNodeType;
// ------------------------------------------------------------------
// 3. REACT FLOW TYPES (The Visual State)
// ------------------------------------------------------------------


export type AppEdge = Edge;

export interface WorkflowCanvasState {
  nodes: AppNode[];
  edges: AppEdge[];
}

// ------------------------------------------------------------------
// 4. THE FULL WORKFLOW RECORD
// Use this type when passing the full database row into components.
// ------------------------------------------------------------------

export interface TypedWorkflow {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  
  // The React Flow UI layout
  uiNodes: AppNode[];
  uiEdges: AppEdge[];
  
  // The deeply validated Zod-backed Execution Graph
  definition: WorkflowDefinition; 
  
  orgId: string;
  eventId: string | null;
  
  createdAt: Date;
  updatedAt: Date;
}