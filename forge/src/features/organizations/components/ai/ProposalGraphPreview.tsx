"use client";

// src/features/organizations/components/ai/ProposalGraphPreview.tsx
//
// ASSIGNMENT 37.10 — READ-ONLY PROPOSAL GRAPH PREVIEW.
//
// Renders the deterministic projection of a reviewed workflow proposal as a
// React Flow graph so the human can see the dependency structure — layers,
// edge direction, and which steps are critical — before approving it.
//
// It is a VIEW and nothing else:
//   - nodes are not draggable, not connectable and not selectable, and the
//     delete key is disabled, so nothing can be edited or removed here;
//   - it calls no service, posts nothing, and never touches lifecycle state. A
//     projection failure is rendered as an error; it does not fabricate a
//     state, and the surrounding review card keeps reporting whatever the
//     server last said;
//   - it reuses the canvas `ActionNode` renderer rather than introducing a
//     second node renderer or a second node model. The only addition is a
//     criticality chip, because `ActionNode` does not surface `isCritical` and
//     the preview exists to show it.
//
// The graph is NOT workflow state. A proposal has no trigger node and no run
// has happened, so no node carries an execution status, and nothing here
// implies a workflow exists — see the caption, which is required because an
// APPROVED proposal still materializes nothing until Assignment 37.11.

import { useMemo } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  type NodeProps,
} from "@xyflow/react";

import ActionNode from "@/features/organizations/components/workflow/nodes/ActionNode";
import type { ActionNodeType } from "@/lib/workflow-types/workflow";
import type { WorkflowProposal } from "@/lib/workflow-types/workflow-proposal";
import { projectProposalToUIGraph } from "@/lib/workflow-types/proposal-ui-projection";

const WRAPPER_CLASS =
  "mt-4 overflow-hidden rounded-xl border border-zinc-800 bg-[#0a0a0a]";
const CANVAS_CLASS = "h-[50vh] min-h-[320px] w-full";

// Mirrors the canvas: one map keyed by node discriminant, holding the SAME
// `ActionNode` renderer the workflow canvas uses.
const nodeTypes = {
  action: PreviewActionNode,
};

/**
 * The shared canvas node, plus the one thing the preview must show that the
 * canvas does not render: the human's criticality decision for that step.
 */
function PreviewActionNode(props: NodeProps<ActionNodeType>) {
  const critical = props.data.isCritical === true;

  return (
    <div className="relative">
      <ActionNode {...props} />
      <span
        className={`pointer-events-none absolute -bottom-3 left-0 rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-widest ${
          critical
            ? "border-rose-800/70 bg-rose-950/90 text-rose-300"
            : "border-zinc-700 bg-zinc-900/90 text-zinc-400"
        }`}
      >
        {critical ? "Critical" : "Non-critical"}
      </span>
    </div>
  );
}

export type ProposalGraphPreviewProps = {
  /** The canonical proposal, read from the same response as the decisions. */
  proposal: WorkflowProposal;
  /**
   * The human's COMPLETE per-step decision set. Typed `unknown` because the
   * projection validates it at runtime rather than trusting the type: a set
   * that is missing a step, has an extra step, or holds a non-boolean is
   * rejected instead of being defaulted to non-critical.
   */
  criticality: unknown;
  className?: string;
};

export function ProposalGraphPreview({
  proposal,
  criticality,
  className,
}: ProposalGraphPreviewProps) {
  const result = useMemo(
    () => projectProposalToUIGraph(proposal, criticality),
    [proposal, criticality],
  );

  if (!result.success) {
    return (
      <section
        aria-label="Workflow proposal graph"
        className={className ?? WRAPPER_CLASS}
      >
        <p role="alert" className="text-xs text-red-400">
          The proposal graph could not be rendered.
        </p>
        <ul className="mt-2 space-y-1">
          {result.issues.map((issue) => (
            <li
              key={`${issue.code}:${issue.path}`}
              className="text-[11px] text-zinc-500"
            >
              {issue.message}
            </li>
          ))}
        </ul>
      </section>
    );
  }

  const { uiNodes, uiEdges } = result;

  return (
    <section
      aria-label="Workflow proposal graph"
      className={className ?? WRAPPER_CLASS}
    >
      <header className="border-b border-zinc-900 px-4 py-3">
        <p className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
          Proposal graph
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
          Read-only preview of the reviewed proposal. Nothing has been created.
        </p>
      </header>

      <div className={CANVAS_CLASS}>
        <ReactFlowProvider>
          <ReactFlow
            nodes={uiNodes}
            edges={uiEdges}
            nodeTypes={nodeTypes}
            fitView
            colorMode="dark"
            // Read-only affordances: inspect the graph, never edit it.
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable={false}
            elementsSelectable={false}
            deleteKeyCode={null}
            panOnDrag
            zoomOnScroll
            zoomOnPinch
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} size={1} color="#3f3f46" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </section>
  );
}
