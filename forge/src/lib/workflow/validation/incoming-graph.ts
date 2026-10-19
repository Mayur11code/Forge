// src/lib/workflow/validation/incoming-graph.ts
//
// The shared persistence-boundary schemas for UI nodes and edges.
//
// These were extracted verbatim from `src/app/actions/workflows/workflow.ts`
// (Assignment 37.11) so the proposal materializer can validate a projected graph
// through the SAME boundary the canvas save path uses. There is deliberately one
// implementation of this contract: a second, weaker copy in the materializer
// would let the two validate different things while both claiming to be "the
// persistence boundary".
//
// Node validation at the persistence boundary.
//
// `data` used to be `.optional().or(z.any())`. `z.any()` accepts every value,
// including `undefined`, so the union's right-hand branch always succeeded and
// the left-hand branch was never reached: `eventId`, `actionType`, `config` and
// `isCritical` - everything that decides what executes - crossed the boundary
// unchecked.
//
// The union discriminates on the node's own `type`, not on `data.type`. React
// Flow carries the discriminator at the top level and `AppNode`'s inferred data
// type has no `type` field, so a union keyed on `data.type` would reject every
// node this application actually creates. Keying it on `node.type` also makes
// the two impossible to disagree: a node typed `trigger` must carry trigger data,
// with no cross-field refinement needed to notice when it does not.

import { z } from "zod";

import {
  ActionNodeDataSchema,
  TriggerNodeDataSchema,
} from "@/lib/workflow-types/workflow";

export const IncomingNodeSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    type: z.literal("trigger"),
    position: z.object({ x: z.number(), y: z.number() }),
    data: TriggerNodeDataSchema,
  }),
  z.object({
    id: z.string(),
    type: z.literal("action"),
    position: z.object({ x: z.number(), y: z.number() }),
    data: ActionNodeDataSchema,
  }),
]);

export const IncomingNodesSchema = z.array(IncomingNodeSchema);

/**
 * Edges are validated on the same terms as nodes, and persisted from the parsed
 * result for the same reason: `compileWorkflow` is the only thing that turns
 * drawn edges into `dependsOn`, so an unvalidated edge is an unchecked
 * instruction to the execution engine, and persisting the raw argument would
 * store whatever the client sent in the JSONB column alongside a validated node
 * set.
 *
 * React Flow carries optional presentation fields (`type`, `animated`, `label`,
 * markers, style). They are passed through rather than stripped, because they are
 * meaningful to the editor and harmless to the compiler, which reads only
 * `source` and `target`.
 */
export const IncomingEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  sourceHandle: z.string().nullish(),
  targetHandle: z.string().nullish(),
  type: z.string().optional(),
  animated: z.boolean().optional(),
  label: z.string().optional(),
});

export const IncomingEdgesSchema = z.array(IncomingEdgeSchema);

export type IncomingNode = z.infer<typeof IncomingNodeSchema>;
export type IncomingEdge = z.infer<typeof IncomingEdgeSchema>;
