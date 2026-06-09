//server boundary

import { z } from 'zod';
import type { Node, Edge } from '@xyflow/react';
import { StepExecutionStatus } from '@prisma/client';

const ExecutionStatusSchema = z
  .enum(StepExecutionStatus)
  .optional();


export const WorkflowStepSchema = z.object({
  id: z.string(),
  action: z.string(), 
  dependsOn: z.array(z.string()), 
  // Tells the engine which branch this node sits on
  routingConditions: z.record(z.string(), z.string()).optional(),
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
  steps: z.record(z.string(), WorkflowStepSchema),
});

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;


//frontend ui payloads
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


export type TriggerNodeType = Node<TriggerNodeData, 'trigger'>;
export type ActionNodeType = Node<ActionNodeData, 'action'>;

export type AppNode = TriggerNodeType | ActionNodeType;
export type AppEdge = Edge;

export interface WorkflowCanvasState {
  nodes: AppNode[];
  edges: AppEdge[];
}


// to be used when passing full database rows into components
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