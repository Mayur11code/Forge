/** @jest-environment jsdom */

// src/tests/workflow/fc013-properties-and-variables.test.tsx
//
// FC-013 — Schema-driven PropertiesPanel, variable auto-mapping, reference
// validation, and runtime resolver compatibility tests.

import "@testing-library/jest-dom";
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

jest.mock("@/lib/prisma/db", () => ({ db: {} }));
jest.mock("@/lib/prisma/extended", () => ({ prisma: {} }));

import {
  AVAILABLE_ACTIONS,
  getDefaultConfigForAction,
  validateActionNodeConfig,
} from "@/lib/workflow-types/registry";
import {
  autoMapNodeVariables,
  formatVariableExpression,
  getAvailableUpstreamOutputs,
} from "@/lib/workflow/graph-ui/utils";
import { resolveInputs } from "@/lib/workflow/execution/resolver";
import type { AppEdge, AppNode } from "@/lib/workflow-types/workflow";

// Mock React Flow hooks for PropertiesPanel UI tests
let mockSelectedIds: string[] = [];
let mockNodes: AppNode[] = [];
let mockEdges: AppEdge[] = [];
const updateNodeDataMock = jest.fn((id: string, patch: Record<string, unknown>) => {
  mockNodes = mockNodes.map((n) =>
    n.id === id ? ({ ...n, data: { ...n.data, ...patch } } as AppNode) : n,
  );
});

jest.mock("@xyflow/react", () => ({
  useReactFlow: () => ({
    updateNodeData: updateNodeDataMock,
    getNodes: () => mockNodes,
    setNodes: (updater: AppNode[] | ((nds: AppNode[]) => AppNode[])) => {
      mockNodes = typeof updater === "function" ? updater(mockNodes) : updater;
    },
  }),
  useOnSelectionChange: ({
    onChange,
  }: {
    onChange: (sel: { nodes: AppNode[] }) => void;
  }) => {
    const ReactRef = jest.requireActual<typeof import("react")>("react");
    ReactRef.useEffect(() => {
      onChange({
        nodes: mockNodes.filter((n) => mockSelectedIds.includes(n.id)),
      });
    }, []);
  },
  useNodesData: (id: string | null) =>
    mockNodes.find((n) => n.id === id) as unknown,
  useNodes: () => mockNodes,
  useEdges: () => mockEdges,
}));

import PropertiesPanel from "@/features/organizations/components/workflow/PropertiesPanel";

describe("FC-013 schema derivation & defaults", () => {
  it("derives required, optional, defaults, descriptions, and enum options from ActionCapabilities", () => {
    const taskCreate = AVAILABLE_ACTIONS.find((a) => a.id === "task.create")!;
    expect(taskCreate).toBeDefined();

    const title = taskCreate.fields.find((f) => f.name === "title")!;
    const projectId = taskCreate.fields.find((f) => f.name === "projectId")!;
    const priority = taskCreate.fields.find((f) => f.name === "priority")!;
    const description = taskCreate.fields.find((f) => f.name === "description")!;

    expect(title.required).toBe(true);
    expect(projectId.required).toBe(true);
    expect(description.required).toBe(false);
    expect(priority.required).toBe(false);
    expect(priority.defaultValue).toBe("MEDIUM");
    expect(priority.options).toEqual([
      { value: "LOW", label: "Low" },
      { value: "MEDIUM", label: "Medium" },
      { value: "HIGH", label: "High" },
    ]);
    expect(title.description).toContain("Short, imperative title");

    expect(getDefaultConfigForAction("task.create")).toEqual({
      priority: "MEDIUM",
    });
  });
});

describe("FC-013 upstream discovery, auto-mapping & ambiguous providers", () => {
  it("auto-maps unambiguous required fields using canonical {{stepId.outputs.field}} / {{trigger.outputs.field}}", () => {
    let nodes: AppNode[] = [
      {
        id: "trig_1",
        type: "trigger",
        position: { x: 0, y: 0 },
        data: { label: "On Task Created", eventId: "task.created" },
      },
      {
        id: "act_1",
        type: "action",
        position: { x: 0, y: 100 },
        data: {
          label: "Create a Task",
          actionType: "task.create",
          config: { title: "Existing Manual Title" },
          isConfigured: false,
          isCritical: false,
        },
      },
    ];
    const edges: AppEdge[] = [{ id: "e1", source: "trig_1", target: "act_1" }];

    autoMapNodeVariables("act_1", edges, (updater) => {
      nodes = typeof updater === "function" ? updater(nodes) : updater;
    });

    const updated = nodes.find((n) => n.id === "act_1")!;
    expect((updated.data as { config: Record<string, unknown> }).config).toEqual({
      title: "Existing Manual Title", // manual value preserved
      projectId: "{{trigger.outputs.projectId}}",
    });
  });

  it("does NOT silently auto-map when multiple upstream providers expose the same outputKey", () => {
    let nodes: AppNode[] = [
      {
        id: "trig_a",
        type: "trigger",
        position: { x: 0, y: 0 },
        data: { label: "Task Trigger", eventId: "task.created" },
      },
      {
        id: "trig_b",
        type: "trigger",
        position: { x: 200, y: 0 },
        data: { label: "Project Trigger", eventId: "project.created" },
      },
      {
        id: "act_1",
        type: "action",
        position: { x: 100, y: 120 },
        data: {
          label: "Create a Task",
          actionType: "task.create",
          config: {},
          isConfigured: false,
          isCritical: false,
        },
      },
    ];
    const edges: AppEdge[] = [
      { id: "e1", source: "trig_a", target: "act_1" },
      { id: "e2", source: "trig_b", target: "act_1" },
    ];

    autoMapNodeVariables("act_1", edges, (updater) => {
      nodes = typeof updater === "function" ? updater(nodes) : updater;
    });

    const updated = nodes.find((n) => n.id === "act_1")!;
    expect((updated.data as { config: Record<string, unknown> }).config.projectId).toBeUndefined();
  });

  it("excludes downstream nodes from upstream discovery", () => {
    const nodes: AppNode[] = [
      {
        id: "act_1",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Step 1",
          actionType: "task.create",
          config: {},
          isConfigured: false,
          isCritical: false,
        },
      },
      {
        id: "act_downstream",
        type: "action",
        position: { x: 0, y: 100 },
        data: {
          label: "Step 2",
          actionType: "task.create",
          config: {},
          isConfigured: false,
          isCritical: false,
        },
      },
    ];
    const edges: AppEdge[] = [
      { id: "e1", source: "act_1", target: "act_downstream" },
    ];

    expect(getAvailableUpstreamOutputs("act_1", nodes, edges)).toEqual([]);
  });

  it("canonical variable expression matches runtime resolveInputs()", () => {
    const expr = formatVariableExpression("act_1", "action", "taskId");
    expect(expr).toBe("{{act_1.outputs.taskId}}");

    const resolved = resolveInputs(
      {
        title: "Follow-up for {{trigger.outputs.taskId}}",
        refId: expr,
      },
      {
        trigger: { outputs: { taskId: "t_100" } },
        act_1: { outputs: { taskId: "t_200" } },
      },
    );

    expect(resolved).toEqual({
      title: "Follow-up for t_100",
      refId: "t_200",
    });
  });
});

describe("FC-013 reference and literal validation", () => {
  const upstream = [
    { sourceNodeId: "trig_1", sourceNodeType: "trigger" as const, outputKey: "projectId" },
    { sourceNodeId: "act_prev", sourceNodeType: "action" as const, outputKey: "title" },
  ];

  it("accepts valid variable references even when literal Zod type expects cuid", () => {
    const issues = validateActionNodeConfig(
      "task.create",
      {
        title: "{{act_prev.outputs.title}}",
        projectId: "{{trigger.outputs.projectId}}",
      },
      upstream,
    );
    expect(issues).toEqual([]);
  });

  it("rejects missing required inputs and invalid literal values", () => {
    const issues = validateActionNodeConfig(
      "task.create",
      { title: "ab", projectId: "not-a-cuid" },
      upstream,
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "title", code: "INVALID_INPUT_TYPE" }),
        expect.objectContaining({ field: "projectId", code: "INVALID_INPUT_TYPE" }),
      ]),
    );
  });

  it("rejects unknown/downstream variable references and malformed braces", () => {
    const issues = validateActionNodeConfig(
      "task.create",
      {
        title: "{{downstream.outputs.title}}",
        projectId: "{{trigger.outputs.projectId",
      },
      upstream,
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "title", code: "INVALID_VARIABLE_REFERENCE" }),
        expect.objectContaining({ field: "projectId", code: "INVALID_VARIABLE_REFERENCE" }),
      ]),
    );
  });
});

describe("FC-013 PropertiesPanel UI & manual variable picker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNodes = [
      {
        id: "trig_1",
        type: "trigger",
        position: { x: 0, y: 0 },
        data: { label: "On Task Created", eventId: "task.created" },
      },
      {
        id: "act_1",
        type: "action",
        position: { x: 0, y: 100 },
        data: {
          label: "Create a Task",
          actionType: "task.create",
          config: { title: "Follow up: ", priority: "MEDIUM" },
          isConfigured: true,
          isCritical: false,
        },
      },
    ];
    mockEdges = [{ id: "e1", source: "trig_1", target: "act_1" }];
    mockSelectedIds = ["act_1"];
  });

  it("renders schema fields, descriptions, inline errors, and inserts canonical upstream variables", () => {
    render(<PropertiesPanel />);

    expect(screen.getByLabelText("Task Title")).toBeInTheDocument();
    expect(screen.getByText(/Short, imperative title/i)).toBeInTheDocument();
    // projectId is missing -> inline error displayed
    expect(screen.getByText("projectId is required.")).toBeInTheDocument();

    // Open variable picker for Task Title and insert taskId
    fireEvent.click(screen.getByLabelText("Insert variable for Task Title"));
    expect(screen.getByText("{{trigger.outputs.taskId}}", { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Insert" })[0]);

    expect(updateNodeDataMock).toHaveBeenCalledWith(
      "act_1",
      expect.objectContaining({
        config: expect.objectContaining({
          title: "Follow up: {{trigger.outputs.taskId}}",
        }),
      }),
    );
  });
});
