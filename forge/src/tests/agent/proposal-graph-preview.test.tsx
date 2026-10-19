/** @jest-environment jsdom */

// src/tests/agent/proposal-graph-preview.test.tsx
//
// Assignment 37.10 — the read-only proposal graph preview.
//
// This is a CLIENT component whose whole job is to render the deterministic
// projection and offer no way to act on it. jsdom + React Testing Library, with
// `@xyflow/react` replaced by a minimal double that renders the node map the
// component supplies, so the REAL `ActionNode` renderer and the real criticality
// chip both run. The projection's own algorithm is covered separately by
// proposal-ui-projection.test.ts; here the subject is the surface:
//
//   1. the graph is rendered and is read-only (no drag, connect, select, delete);
//   2. each node is the shared canvas renderer plus the criticality decision;
//   3. a projection failure is an error, never a fabricated "non-critical" node;
//   4. the caption states that nothing has been created.

import "@testing-library/jest-dom";

import { render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";

jest.mock("@xyflow/react", () => ({
  ReactFlowProvider: ({ children }: { children?: unknown }) => <>{children}</>,
  ReactFlow: (props: {
    nodes: Array<{ id: string; type?: string; data: Record<string, unknown> }>;
    edges: Array<{ id: string; source: string; target: string }>;
    nodeTypes: Record<
      string,
      ComponentType<{ id: string; type?: string; data: Record<string, unknown> }>
    >;
    nodesDraggable?: boolean;
    nodesConnectable?: boolean;
    edgesFocusable?: boolean;
    elementsSelectable?: boolean;
    deleteKeyCode?: string | null;
    children?: ReactNode;
  }) => (
    <div
      data-testid="react-flow"
      data-nodes={String(props.nodes.length)}
      data-edges={String(props.edges.length)}
      data-nodes-draggable={String(props.nodesDraggable)}
      data-nodes-connectable={String(props.nodesConnectable)}
      data-edges-focusable={String(props.edgesFocusable)}
      data-elements-selectable={String(props.elementsSelectable)}
      data-delete-key={String(props.deleteKeyCode)}
    >
      {props.nodes.map((node) => {
        const Node = props.nodeTypes[node.type ?? ""];
        return (
          <div key={node.id} data-testid={`node-${node.id}`}>
            <Node id={node.id} type={node.type} data={node.data} />
          </div>
        );
      })}
      {props.edges.map((edge) => (
        <span key={edge.id} data-testid="edge">
          {`${edge.source}->${edge.target}`}
        </span>
      ))}
      {props.children}
    </div>
  ),
  Background: () => <div data-testid="background" />,
  Controls: (props: { showInteractive?: boolean }) => (
    <div
      data-testid="controls"
      data-show-interactive={String(props.showInteractive)}
    />
  ),
  Position: { Top: "top", Bottom: "bottom" },
  Handle: () => <div data-testid="handle" />,
  useStore: (selector: (state: { nodes: unknown[]; edges: unknown[] }) => unknown) =>
    selector({ nodes: [], edges: [] }),
}));

import { ProposalGraphPreview } from "@/features/organizations/components/ai/ProposalGraphPreview";
import type { WorkflowProposal } from "@/lib/workflow-types/workflow-proposal";

const PROJECT_ID = "clxyz0000000000000000000a";

const PROPOSAL: WorkflowProposal = {
  name: "Onboard a client",
  description: "Kick off the onboarding.",
  steps: {
    kickoff: {
      action: "task.create",
      inputs: { title: "Kick off", projectId: PROJECT_ID },
      dependsOn: [],
    },
    follow: {
      action: "task.create",
      inputs: { title: "Follow up", projectId: PROJECT_ID },
      dependsOn: ["kickoff"],
    },
  },
};

const DECISIONS = { kickoff: true, follow: false };

function renderPreview(criticality: unknown, proposal: WorkflowProposal = PROPOSAL) {
  return render(
    <ProposalGraphPreview proposal={proposal} criticality={criticality} />,
  );
}

describe("ProposalGraphPreview — the read-only graph", () => {
  it("renders one node per step and one edge per dependency", () => {
    renderPreview(DECISIONS);

    const graph = screen.getByTestId("react-flow");
    expect(graph).toHaveAttribute("data-nodes", "2");
    expect(graph).toHaveAttribute("data-edges", "1");
    expect(screen.getByTestId("edge")).toHaveTextContent("kickoff->follow");
  });

  it("offers no way to edit the graph", () => {
    renderPreview(DECISIONS);

    const graph = screen.getByTestId("react-flow");
    expect(graph).toHaveAttribute("data-nodes-draggable", "false");
    expect(graph).toHaveAttribute("data-nodes-connectable", "false");
    expect(graph).toHaveAttribute("data-edges-focusable", "false");
    expect(graph).toHaveAttribute("data-elements-selectable", "false");
    expect(graph).toHaveAttribute("data-delete-key", "null");
    expect(screen.getByTestId("controls")).toHaveAttribute(
      "data-show-interactive",
      "false",
    );
  });

  it("renders the shared ActionNode for each step, plus the criticality chip", () => {
    renderPreview(DECISIONS);

    // Labels and the body come from the real canvas renderer...
    expect(screen.getByText("kickoff (task.create)")).toBeInTheDocument();
    expect(screen.getByText("follow (task.create)")).toBeInTheDocument();
    expect(screen.getAllByText("task.create")).toHaveLength(2);

    // ...and the chip is the only addition this preview makes.
    expect(screen.getAllByText("Critical")).toHaveLength(1);
    expect(screen.getAllByText("Non-critical")).toHaveLength(1);
  });

  it("says nothing has been created, because nothing has", () => {
    renderPreview(DECISIONS);

    expect(
      screen.getByRole("region", { name: "Workflow proposal graph" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Read-only preview of the reviewed proposal. Nothing has been created.",
      ),
    ).toBeInTheDocument();
  });
});

describe("ProposalGraphPreview — a failure is an error, not a state", () => {
  it("reports an incomplete decision set instead of rendering unclassified steps", () => {
    renderPreview({ kickoff: true });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The proposal graph could not be rendered.",
    );
    expect(
      screen.getByText('No criticality decision was supplied for step "follow".'),
    ).toBeInTheDocument();

    // Critically: no graph, and no step silently presented as non-critical.
    expect(screen.queryByTestId("react-flow")).toBeNull();
    expect(screen.queryByText("Non-critical")).toBeNull();
  });

  it("reports an undecidable proposal rather than guessing a layout", () => {
    const cyclic: WorkflowProposal = {
      name: "Cycle",
      steps: {
        a: {
          action: "task.create",
          inputs: { title: "A", projectId: PROJECT_ID },
          dependsOn: ["b"],
        },
        b: {
          action: "task.create",
          inputs: { title: "B", projectId: PROJECT_ID },
          dependsOn: ["a"],
        },
      },
    };

    renderPreview({ a: true, b: false }, cyclic);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("react-flow")).toBeNull();
  });

  it("does not raise an alert for a graph it can draw", () => {
    renderPreview(DECISIONS);

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
