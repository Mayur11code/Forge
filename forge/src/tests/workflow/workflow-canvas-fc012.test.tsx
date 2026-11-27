/** @jest-environment jsdom */

// src/tests/workflow/workflow-canvas-fc012.test.tsx
//
// FC-012 — UI authoring tests for WorkflowCanvas & WorkflowEditorHeader.

import "@testing-library/jest-dom";
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const pushMock = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  useParams: () => ({ orgId: "acme" }),
}));

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("@/app/actions/workflows/workflow", () => ({
  saveWorkflowState: jest.fn(),
  updateWorkflowState: jest.fn(),
}));

jest.mock("@/app/actions/workflows/workflow-run", () => ({
  triggerWorkflowRun: jest.fn(),
}));

// Lightweight React Flow mock so jsdom tests canvas controls, MiniMap, and save flows cleanly.
jest.mock("@xyflow/react", () => {
  const actualReact = jest.requireActual<typeof import("react")>("react");
  return {
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="rf-provider">{children}</div>
    ),
    ReactFlow: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="rf-canvas">{children}</div>
    ),
    Background: () => <div data-testid="rf-background" />,
    Controls: () => <div data-testid="rf-controls" />,
    MiniMap: () => <div data-testid="rf-minimap" />,
    useNodesState: (initial: unknown[]) => actualReact.useState(initial),
    useEdgesState: (initial: unknown[]) => actualReact.useState(initial),
    useReactFlow: () => ({
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
      getNodes: () => [],
      updateNodeData: jest.fn(),
      setNodes: jest.fn(),
      fitView: jest.fn(),
    }),
    useOnSelectionChange: jest.fn(),
    useNodesData: () => undefined,
    useNodes: () => [],
    useEdges: () => [],
    addEdge: jest.fn((conn, eds) => [...eds, conn]),
    getOutgoers: jest.fn(() => []),
  };
});

import { toast } from "sonner";
import {
  saveWorkflowState,
  updateWorkflowState,
} from "@/app/actions/workflows/workflow";
import WorkflowBuilder from "@/features/organizations/components/workflow/WorkflowCanvas";
import type { AppNode } from "@/lib/workflow-types/workflow";

const saveWorkflowStateMock = saveWorkflowState as jest.Mock;
const updateWorkflowStateMock = updateWorkflowState as jest.Mock;
const toastSuccessMock = toast.success as jest.Mock;
const toastErrorMock = toast.error as jest.Mock;

const SAMPLE_NODES: AppNode[] = [
  {
    id: "trigger_1",
    type: "trigger",
    position: { x: 0, y: 0 },
    data: { label: "On Task Created", eventId: "task.created" },
  },
];

beforeEach(() => {
  jest.clearAllMocks();
});

describe("WorkflowBuilder FC-012 authoring UX", () => {
  it("renders new workflow with editable default title 'Untitled workflow', Controls, and MiniMap", () => {
    render(<WorkflowBuilder />);

    expect(screen.getByText("Untitled workflow")).toBeInTheDocument();
    expect(screen.getByText("Add a workflow description...")).toBeInTheDocument();
    expect(screen.getByTestId("rf-controls")).toBeInTheDocument();
    expect(screen.getByTestId("rf-minimap")).toBeInTheDocument();
  });

  it("displays persisted title and description for an existing workflow", () => {
    render(
      <WorkflowBuilder
        workflowId="wf_1"
        initialName="Bug Escalation"
        initialDescription="Escalates high-priority tasks."
        initialNodes={SAMPLE_NODES}
        initialEdges={[]}
      />,
    );

    expect(screen.getByText("Bug Escalation")).toBeInTheDocument();
    expect(screen.getByText("Escalates high-priority tasks.")).toBeInTheDocument();
  });

  it("supports inline title editing with Enter to confirm and Escape to cancel", async () => {
    updateWorkflowStateMock.mockResolvedValue({ success: true });

    render(
      <WorkflowBuilder
        workflowId="wf_1"
        initialName="Original Flow"
        initialNodes={SAMPLE_NODES}
        initialEdges={[]}
      />,
    );

    // Cancel with Escape
    fireEvent.click(screen.getByTitle("Click to rename workflow"));
    const input = screen.getByLabelText("Workflow name");
    fireEvent.change(input, { target: { value: "Discarded Name" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByText("Original Flow")).toBeInTheDocument();
    expect(updateWorkflowStateMock).not.toHaveBeenCalled();

    // Confirm with Enter
    fireEvent.click(screen.getByTitle("Click to rename workflow"));
    const input2 = screen.getByLabelText("Workflow name");
    fireEvent.change(input2, { target: { value: "Confirmed Name" } });
    fireEvent.keyDown(input2, { key: "Enter" });

    await waitFor(() =>
      expect(updateWorkflowStateMock).toHaveBeenCalledWith(
        "acme",
        "wf_1",
        SAMPLE_NODES,
        [],
        expect.objectContaining({ name: "Confirmed Name", description: null }),
      ),
    );
    expect(toastSuccessMock).toHaveBeenCalledWith("Workflow metadata updated.");
    expect(screen.getByText("Confirmed Name")).toBeInTheDocument();
  });

  it("supports editing workflow description and persists on Save Canvas", async () => {
    updateWorkflowStateMock.mockResolvedValue({ success: true });

    render(
      <WorkflowBuilder
        workflowId="wf_1"
        initialName="Flow A"
        initialNodes={SAMPLE_NODES}
        initialEdges={[]}
      />,
    );

    fireEvent.click(screen.getByTitle("Click to edit workflow description"));
    const descInput = screen.getByLabelText("Workflow description");
    fireEvent.change(descInput, { target: { value: "Notifies team" } });
    fireEvent.keyDown(descInput, { key: "Enter" });

    await waitFor(() =>
      expect(updateWorkflowStateMock).toHaveBeenCalledWith(
        "acme",
        "wf_1",
        SAMPLE_NODES,
        [],
        expect.objectContaining({ name: "Flow A", description: "Notifies team" }),
      ),
    );
    expect(screen.getByText("Notifies team")).toBeInTheDocument();
  });

  it("shows toast.success on create and toast.error on failed save", async () => {
    saveWorkflowStateMock.mockResolvedValueOnce({
      success: false,
      error: "Steps form a cycle: a -> b -> a.",
    });

    const { rerender } = render(
      <WorkflowBuilder initialNodes={SAMPLE_NODES} initialEdges={[]} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /save workflow/i }));
    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("Steps form a cycle: a -> b -> a."),
    );
    expect(toastSuccessMock).not.toHaveBeenCalled();

    saveWorkflowStateMock.mockResolvedValueOnce({
      success: true,
      workflowId: "wf_new",
    });
    rerender(<WorkflowBuilder initialNodes={SAMPLE_NODES} initialEdges={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /save workflow/i }));

    await waitFor(() =>
      expect(toastSuccessMock).toHaveBeenCalledWith("Workflow created."),
    );
    expect(pushMock).toHaveBeenCalledWith("/org/acme/workflows/wf_new");
  });

  it("prevents duplicate save submissions while a save is pending", async () => {
    let resolveSave: (v: unknown) => void = () => {};
    updateWorkflowStateMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );

    render(
      <WorkflowBuilder
        workflowId="wf_1"
        initialName="Pending Flow"
        initialNodes={SAMPLE_NODES}
        initialEdges={[]}
      />,
    );

    const saveBtn = screen.getByRole("button", { name: /save canvas/i });
    fireEvent.click(saveBtn);
    await waitFor(() => expect(updateWorkflowStateMock).toHaveBeenCalledTimes(1));

    expect(saveBtn).toBeDisabled();
    fireEvent.click(saveBtn);
    expect(updateWorkflowStateMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSave({ success: true });
    });
  });
});
