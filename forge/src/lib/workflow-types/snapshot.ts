// src/lib/workflow-types/snapshot.ts
//
// F-03: Immutable Workflow Execution Snapshot envelope and schemas.
// Every newly ignited WorkflowRun captures its execution contract here at
// ignition under transactional row lock. Runtime execution paths (evaluator,
// worker, resolver, wrapper, and compensation) read exclusively from this
// envelope, never from mutable Workflow.definition.

import { z } from "zod";
import { WorkflowDefinitionSchema, type WorkflowDefinition } from "./workflow";

export interface WorkflowActionManifestEntry {
  stepId: string;
  actionId: string;
  actionVersion: string;
}

export interface WorkflowExecutionSnapshot {
  snapshotSchemaVersion: number;
  workflowId: string;
  workflowName: string;
  definition: WorkflowDefinition;
  actionManifest: WorkflowActionManifestEntry[];
  createdAt: string;
}

export const WorkflowActionManifestEntrySchema = z.object({
  stepId: z.string().min(1),
  actionId: z.string().min(1),
  actionVersion: z.string().min(1),
});

export const WorkflowExecutionSnapshotSchema = z.object({
  snapshotSchemaVersion: z.literal(1),
  workflowId: z.string().min(1),
  workflowName: z.string().min(1),
  definition: WorkflowDefinitionSchema,
  actionManifest: z.array(WorkflowActionManifestEntrySchema),
  createdAt: z.string().min(1),
});
