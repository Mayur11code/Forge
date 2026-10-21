// src/tests/agent/generate-workflow.test.ts
//
// Assignment 37.5 — the `generateWorkflow` macro agent tool.
//
// The tool's whole job is to turn model intent into a validated proposal and
// nothing else. These tests pin four things:
//
//   A. Registration and policy: the tool is model-visible, resolves from the
//      registry server-side, is READ_ONLY (so it runs without approval), and an
//      unregistered name still fails closed.
//   B. Success: a valid proposal survives compilation with its name, optional
//      description, step keys, actions, inputs and dependencies intact, and the
//      candidate definition is never returned as if it were persisted.
//   C. Failure: the compiler's issues reach the model through the shared
//      envelope, with `code`, `path` and `message` preserved, and the durable
//      tool-result path persists them so the next turn can correct them.
//   D. No forbidden side effects: no action execute, no workflow start, no
//      workflow/run row, no proposal persistence, no queue event.
//
// Structural violations the model-facing schema rejects are distinguished from
// semantic failures the compiler reports: the SDK rejects the former before the
// executor runs, so those are asserted against the schema directly, not claimed
// to reach the executor.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/prisma/extended", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { prisma: prismaDouble };
});

jest.mock("@/lib/prisma/db", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { db: prismaDouble };
});

jest.mock("@/lib/events/queue", () => ({ publishEvent: jest.fn() }));

// Mocked with a minimal factory rather than left to load: the real module pulls
// in the evaluator. It is imported only so a regression that wires execution
// into the proposal executor fails loudly here.
jest.mock("@/lib/workflow/execution/trigger", () => ({
  startWorkflow: jest.fn(),
}));

jest.mock("@/lib/ai/agent/status", () => ({ publishAgentStatus: jest.fn() }));

jest.mock("@/lib/ai/agent/locks", () => ({
  withAgentSessionLock: jest.fn(
    async (_id: string, fn: () => Promise<void>) => fn(),
  ),
  withToolExecutionLock: jest.fn(
    async (_id: string, fn: () => Promise<void>) => fn(),
  ),
}));

jest.mock("@/lib/ai/agent/session-service", () => {
  const actual = jest.requireActual("@/lib/ai/agent/session-service");
  return {
    ...actual,
    failAgentSession: jest.fn(),
  };
});

jest.mock("@/lib/ai/agent/services/message-service", () => ({
  createMessage: jest.fn(),
}));

jest.mock("@/lib/ai/agent/outbox", () => ({
  recordAgentEvent: jest.fn(),
}));

jest.mock("@/lib/ai/agent/services/tool-execution-service", () => ({
  getToolExecutionForWorker: jest.fn(),
  markToolExecutionRunning: jest.fn(),
  failToolExecution: jest.fn(),
  abandonToolExecution: jest.fn(),
  heartbeatToolExecution: jest.fn(async () => true),
}));

import { z } from "zod";

import type { Prisma } from "@prisma/client";

import {
  prismaDouble,
  resetStore,
  restorePrismaDouble,
  store,
} from "./helpers/prisma-double";

import { createTaskAction } from "@/lib/workflow/actions/core/create-task";
import {
  compileWorkflowProposal,
  type WorkflowCompilationResult,
} from "@/lib/workflow-types/workflow-proposal-compiler";
import { WorkflowProposalSchema } from "@/lib/workflow-types/workflow-proposal";
import { startWorkflow } from "@/lib/workflow/execution/trigger";
import { publishEvent } from "@/lib/events/queue";
import {
  agentTools,
  describeToolProposal,
  getToolExecutor,
  getToolPolicy,
  isRegisteredTool,
  requiresToolConfirmation,
} from "@/lib/ai/agent/tools/registry";
import {
  describeGenerateWorkflowProposal,
  executeGenerateWorkflow,
  generateWorkflowAcceptedInputSchema,
  generateWorkflowModelInputSchema,
  generateWorkflowSchema,
  generateWorkflowTool,
} from "@/lib/ai/agent/tools/generate-workflow";
import { createMessage } from "@/lib/ai/agent/services/message-service";
import { recordAgentEvent } from "@/lib/ai/agent/outbox";
import {
  getToolExecutionForWorker,
  heartbeatToolExecution,
  markToolExecutionRunning,
} from "@/lib/ai/agent/services/tool-execution-service";
import { handleToolExecution } from "@/lib/ai/agent/tool-worker";

const prisma = prismaDouble as unknown as {
  task: { findMany: jest.Mock; update: jest.Mock };
};

const PROJECT_ID = "clxyz0000000000000000000a";

type OutputShape = {
  ok: boolean;
  code?: string;
  error?: string;
  issues?: { path: string; code: string; message: string }[];
  proposal?: {
    name: string;
    description?: string;
    steps: Record<
      string,
      { action: string; inputs: Record<string, unknown>; dependsOn: string[] }
    >;
  };
};

/** Narrow a tool executor's discriminated output to its JSON payload. */
function jsonValue(output: unknown): OutputShape {
  return (output as { value: OutputShape }).value;
}

function step(overrides: Record<string, unknown> = {}) {
  return {
    action: "task.create",
    inputs: { title: "Create the onboarding task", projectId: PROJECT_ID },
    dependsOn: [] as string[],
    ...overrides,
  };
}

function validProposal(): Prisma.JsonValue {
  return {
    name: "Onboard a client",
    description: "Kick off the onboarding.",
    steps: {
      kickoff: step(),
      follow: step({
        inputs: {
          title: "Follow up on kickoff",
          projectId: PROJECT_ID,
          description: "Created {{kickoff.outputs.taskId}}",
        },
        dependsOn: ["kickoff"],
      }),
    },
  };
}

function cycleProposal(): Prisma.JsonValue {
  return {
    name: "Loop",
    steps: {
      a: step({ dependsOn: ["b"] }),
      b: step({ dependsOn: ["a"] }),
    },
  };
}

function issuesOf(result: WorkflowCompilationResult) {
  if (result.success) {
    throw new Error("expected compilation to fail");
  }
  return result.issues;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// A. Registration, policy and the server-side boundary
// ---------------------------------------------------------------------------

describe("generateWorkflow registration and policy", () => {
  it("is registered and part of the model-visible tool set", () => {
    expect(isRegisteredTool("generateWorkflow")).toBe(true);
    expect(Object.keys(agentTools)).toContain("generateWorkflow");
  });

  it("is READ_ONLY, so it is dispatched without confirmation", () => {
    expect(getToolPolicy("generateWorkflow")).toEqual({ access: "READ_ONLY" });
    expect(requiresToolConfirmation("generateWorkflow")).toBe(false);
  });

  it("resolves its executor server-side, from the tool name", () => {
    expect(typeof getToolExecutor("generateWorkflow")).toBe("function");
  });

  it("offers no policy field the model can supply or relax", () => {
    // The strict proposal schema rejects any attempt to smuggle a policy or
    // identity field. There is no `access`, no `orgId`, no `userId`.
    const smuggled = generateWorkflowSchema.safeParse({
      name: "x",
      steps: { a: step() },
      access: "READ_ONLY",
      orgId: "other_org",
    });

    expect(smuggled.success).toBe(false);
  });

  it("keeps the 37.2 proposal contract as the parser/compat schema", () => {
    // One schema, not a copy: a proposal the model was told is well-formed
    // cannot be rejected by a drifting duplicate. The model-facing schema is
    // DERIVED from it (see the suite below), so the two cannot drift either.
    expect(generateWorkflowSchema).toBe(WorkflowProposalSchema);
  });

  it("still fails closed for a name that is not registered", () => {
    expect(isRegisteredTool("deleteEverything")).toBe(false);
    expect(getToolPolicy("deleteEverything")).toBeNull();
    expect(requiresToolConfirmation("deleteEverything")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A2. The model-facing schema: one canonical flat object, never a root union
// ---------------------------------------------------------------------------

describe("generateWorkflow model-facing schema", () => {
  type LooseJsonSchema = {
    type?: string;
    anyOf?: unknown;
    oneOf?: unknown;
    properties?: Record<string, unknown>;
    required?: string[];
  };

  it("serializes to a single object, not a root union or anyOf", () => {
    // The regression this fixes: a root `z.union` becomes a root `anyOf` in the
    // tool's JSON Schema, which function-calling handles unreliably - the model
    // must both choose a branch and populate it, and a near-miss matches none.
    const jsonSchema = z.toJSONSchema(
      generateWorkflowModelInputSchema,
    ) as LooseJsonSchema;

    expect(jsonSchema.anyOf).toBeUndefined();
    expect(jsonSchema.oneOf).toBeUndefined();
    expect(jsonSchema.type).toBe("object");

    expect(Object.keys(jsonSchema.properties ?? {}).sort()).toEqual([
      "clarifications",
      "description",
      "name",
      "steps",
    ]);
    // `clarifications` is optional, so it must not be required.
    expect([...(jsonSchema.required ?? [])].sort()).toEqual(["name", "steps"]);
  });

  it("is the exact schema wired into the AI SDK tool", () => {
    // Identity, not equality: the model must be handed this schema and no other.
    expect(
      (generateWorkflowTool as { inputSchema: unknown }).inputSchema,
    ).toBe(generateWorkflowModelInputSchema);
  });

  it("accepts a valid flat proposal", () => {
    expect(
      generateWorkflowModelInputSchema.safeParse(validProposal()).success,
    ).toBe(true);
  });

  it("accepts a non-empty clarifications array alongside the proposal", () => {
    const parsed = generateWorkflowModelInputSchema.safeParse({
      name: "Onboard a client",
      steps: { kickoff: step() },
      clarifications: [
        {
          field: "steps.kickoff.inputs.projectId",
          reason: "task.create requires a project id",
          question: "Which project?",
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects an empty clarifications array rather than silently ignoring it", () => {
    // An empty array is neither an omission nor a real request; it is a
    // malformed call and must fail loudly instead of passing as a plain proposal.
    expect(
      generateWorkflowModelInputSchema.safeParse({
        name: "Onboard a client",
        steps: { kickoff: step() },
        clarifications: [],
      }).success,
    ).toBe(false);
  });

  it("still rejects structurally malformed proposals, before any executor", () => {
    expect(
      generateWorkflowModelInputSchema.safeParse({ name: "Empty", steps: {} })
        .success,
    ).toBe(false);
    expect(
      generateWorkflowModelInputSchema.safeParse({
        name: "Unknown step field",
        steps: { a: { ...step(), id: "backend-owned" } },
      }).success,
    ).toBe(false);
  });

  it("offers no policy or identity field the model can supply or relax", () => {
    expect(
      generateWorkflowModelInputSchema.safeParse({
        name: "x",
        steps: { a: step() },
        access: "READ_ONLY",
        orgId: "other_org",
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A3. Executor input compatibility: all three historical shapes still work
// ---------------------------------------------------------------------------

describe("generateWorkflow executor accepts every historical input shape", () => {
  const missingProjectStep = {
    action: "task.create",
    inputs: { title: "Do work" },
    dependsOn: [] as string[],
  };
  const clarification = {
    field: "steps.kickoff.inputs.projectId",
    reason: "task.create requires a project id",
    question: "Which project?",
  };

  it("accepts the plain proposal (no clarifications)", async () => {
    const value = jsonValue(await executeGenerateWorkflow(validProposal()));
    expect(value.ok).toBe(true);
  });

  it("accepts the nested Form A proposal with clarifications", async () => {
    const value = jsonValue(
      await executeGenerateWorkflow({
        proposal: { name: "Onboard", steps: { kickoff: missingProjectStep } },
        clarifications: [clarification],
      }),
    );

    expect(value.ok).toBe(false);
    expect(value.code).toBe("NEEDS_USER_INPUT");
  });

  it("accepts the flat Form B proposal with clarifications", async () => {
    const value = jsonValue(
      await executeGenerateWorkflow({
        name: "Onboard",
        steps: { kickoff: missingProjectStep },
        clarifications: [clarification],
      }),
    );

    expect(value.ok).toBe(false);
    expect(value.code).toBe("NEEDS_USER_INPUT");
  });

  it("validates all three shapes against the accepted-input schema", () => {
    expect(
      generateWorkflowAcceptedInputSchema.safeParse({
        name: "x",
        steps: { a: step() },
      }).success,
    ).toBe(true);
    expect(
      generateWorkflowAcceptedInputSchema.safeParse({
        proposal: { name: "x", steps: { a: step() } },
        clarifications: [clarification],
      }).success,
    ).toBe(true);
    expect(
      generateWorkflowAcceptedInputSchema.safeParse({
        name: "x",
        steps: { a: step() },
        clarifications: [clarification],
      }).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B. Success contract
// ---------------------------------------------------------------------------

describe("generateWorkflow success", () => {
  it("preserves name, description, step keys, actions, inputs and dependencies", async () => {
    const value = jsonValue(await executeGenerateWorkflow(validProposal()));

    expect(value.ok).toBe(true);
    expect(value.proposal?.name).toBe("Onboard a client");
    expect(value.proposal?.description).toBe("Kick off the onboarding.");
    expect(Object.keys(value.proposal?.steps ?? {}).sort()).toEqual([
      "follow",
      "kickoff",
    ]);
    expect(value.proposal?.steps.kickoff?.action).toBe("task.create");
    expect(value.proposal?.steps.kickoff?.inputs).toEqual({
      title: "Create the onboarding task",
      projectId: PROJECT_ID,
    });
    expect(value.proposal?.steps.follow?.dependsOn).toEqual(["kickoff"]);
    expect(value.proposal?.steps.follow?.inputs.description).toBe(
      "Created {{kickoff.outputs.taskId}}",
    );
  });

  it("omits an absent description rather than inventing one", async () => {
    const value = jsonValue(
      await executeGenerateWorkflow({
        name: "Minimal",
        steps: { a: step() },
      }),
    );

    expect(value.ok).toBe(true);
    expect(value.proposal).not.toHaveProperty("description");
  });

  it("returns the compiler's result and nothing that looks persisted", async () => {
    const input = validProposal();
    const compiled = compileWorkflowProposal(input);

    expect(compiled.success).toBe(true);

    const output = await executeGenerateWorkflow(input);

    // The candidate definition (with its placeholder id/name and mapped
    // `config`) must never cross back to the model as if it were a workflow.
    expect(output).toEqual({
      type: "json",
      value: { ok: true, proposal: jsonValue(output).proposal },
    });
    expect(JSON.stringify(output)).not.toContain('"definition"');
    expect(JSON.stringify(output)).not.toContain('"config"');
    expect(JSON.stringify(output)).not.toContain('"isCritical"');
  });
});

// ---------------------------------------------------------------------------
// C. Failure contract — the compiler's issues, preserved
// ---------------------------------------------------------------------------

describe("generateWorkflow failure", () => {
  it("surfaces an unknown action with its code and the offending path", async () => {
    const input = {
      name: "Bad action",
      steps: { a: step({ action: "task.delete" }) },
    };

    const value = jsonValue(await executeGenerateWorkflow(input));

    expect(value.ok).toBe(false);
    expect(value.code).toBe("INVALID_INPUT");
    expect(value.issues).toEqual([
      expect.objectContaining({
        code: "UNKNOWN_ACTION",
        path: "steps.a.action",
      }),
    ]);
    // The human-readable line names the field too, so a model that only reads
    // `error` can still recover.
    expect(value.error).toContain("steps.a.action");
  });

  it("surfaces a dangling dependency from the graph collector", async () => {
    const value = jsonValue(
      await executeGenerateWorkflow({
        name: "Dangling",
        steps: { a: step({ dependsOn: ["ghost"] }) },
      }),
    );

    expect(value.issues).toEqual([
      expect.objectContaining({
        code: "UNKNOWN_DEPENDENCY",
        path: "steps.a.dependsOn",
      }),
    ]);
  });

  it("surfaces a cycle from the graph collector", async () => {
    const value = jsonValue(await executeGenerateWorkflow(cycleProposal()));

    expect(value.issues).toEqual([
      expect.objectContaining({ code: "CYCLE", path: "steps" }),
    ]);
  });

  it("surfaces a reference to a step that does not exist", async () => {
    const input = {
      name: "Bad reference",
      steps: {
        a: step({
          inputs: {
            title: "Reads a ghost",
            projectId: PROJECT_ID,
            description: "From {{ghost.outputs.taskId}}",
          },
        }),
      },
    };

    const value = jsonValue(await executeGenerateWorkflow(input));

    expect(value.issues).toEqual([
      expect.objectContaining({
        code: "UNKNOWN_REFERENCE_SOURCE",
        path: "steps.a.inputs.description",
      }),
    ]);
  });

  it("returns exactly the compiler's issues, adding and repairing nothing", async () => {
    const input = cycleProposal();
    const compiled = issuesOf(compileWorkflowProposal(input));

    const value = jsonValue(await executeGenerateWorkflow(input));

    expect(value.issues).toEqual(compiled);
  });

  it("does not return a proposal alongside a failure", async () => {
    const value = jsonValue(await executeGenerateWorkflow(cycleProposal()));

    expect(value.proposal).toBeUndefined();
  });

  it("throws on a null payload rather than treating it as model input", async () => {
    // Null cannot come from the model-facing object schema; it is a caller bug.
    await expect(executeGenerateWorkflow(null)).rejects.toThrow(
      "Tool input cannot be null.",
    );
  });

  it("rejects a structurally malformed proposal at the schema, before any executor", () => {
    // Empty steps and unknown step fields are 37.2 structural rules. They are
    // rejected by the model-facing schema, which the SDK validates before the
    // executor runs - so they never produce a tool-result envelope. Only rules
    // the schema does not encode (membership, references, graph semantics)
    // reach the executor, and those are the cases asserted above.
    expect(
      generateWorkflowSchema.safeParse({ name: "Empty", steps: {} }).success,
    ).toBe(false);
    expect(
      generateWorkflowSchema.safeParse({
        name: "Unknown step field",
        steps: { a: { ...step(), id: "backend-owned" } },
      }).success,
    ).toBe(false);
  });

  it("passes a schema-valid but semantically invalid proposal through to the compiler", async () => {
    // `task.create` with an empty inputs object is structurally valid (inputs is
    // an open record) but violates the action's own contract. The schema accepts
    // it; the compiler rejects it with MISSING_REQUIRED_INPUT.
    const input = {
      name: "Missing inputs",
      steps: { a: { action: "task.create", inputs: {}, dependsOn: [] } },
    };

    expect(generateWorkflowSchema.safeParse(input).success).toBe(true);

    const value = jsonValue(await executeGenerateWorkflow(input));

    expect(value.ok).toBe(false);
    expect(value.issues?.map((issue) => issue.code)).toContain(
      "MISSING_REQUIRED_INPUT",
    );
  });
});

// ---------------------------------------------------------------------------
// D. No forbidden workflow side effects
// ---------------------------------------------------------------------------

describe("generateWorkflow side effects", () => {
  it("runs a valid proposal without executing an action or starting a run", async () => {
    const executeSpy = jest.spyOn(createTaskAction, "execute");

    await executeGenerateWorkflow(validProposal());

    // No action executor is reachable, and no workflow execution starts.
    expect(executeSpy).not.toHaveBeenCalled();
    expect(startWorkflow).not.toHaveBeenCalled();
    // No domain event is enqueued.
    expect(publishEvent).not.toHaveBeenCalled();
    // No database write of any kind.
    expect(prisma.task.findMany).not.toHaveBeenCalled();
    expect(prisma.task.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F. Describer contract (presentation only; not on the confirmation path)
// ---------------------------------------------------------------------------

describe("generateWorkflow describer", () => {
  it("renders the proposed name, step count and actions", () => {
    const described = describeGenerateWorkflowProposal(validProposal());

    expect(described).not.toBeNull();
    expect(described?.summary).toContain("Onboard a client");
    expect(described?.summary).toContain("2 steps");
    expect(described?.fields).toEqual(
      expect.arrayContaining([
        { label: "Name", value: "Onboard a client" },
        { label: "Steps", value: "2" },
        { label: "kickoff", value: "task.create" },
      ]),
    );
  });

  it("returns null for arguments that do not parse", () => {
    expect(describeGenerateWorkflowProposal({ nonsense: true })).toBeNull();
  });

  it("is reachable through the shared resolver, with a generic fallback", () => {
    expect(
      describeToolProposal("generateWorkflow", validProposal()).summary,
    ).toContain("Onboard a client");

    expect(describeToolProposal("generateWorkflow", {}).summary).toBe(
      "Run generateWorkflow",
    );
  });

  it("advertises propose-only behaviour in its model-facing description", () => {
    expect(generateWorkflowTool.description).toMatch(/does NOT create/i);
  });
});

// ---------------------------------------------------------------------------
// Durable tool-result path
// ---------------------------------------------------------------------------

describe("generateWorkflow through the durable tool-result path", () => {
  const SESSION_ID = "clxsessionaaaaaaaaaaaaaa";
  const EXECUTION_ID = "clxexecccccccccccccccc";
  const TOOL_CALL_ID = "call_gw_0001";

  beforeEach(() => {
    restorePrismaDouble();
    resetStore();
    // The worker's outcome CAS runs against the double, so the claimed row must
    // exist and be RUNNING. Its terminal status is now written by that same CAS.
    store.executions = [
      {
        id: EXECUTION_ID,
        sessionId: SESSION_ID,
        toolCallId: TOOL_CALL_ID,
        toolName: "generateWorkflow",
        status: "RUNNING",
        input: cycleProposal(),
        error: null,
      },
    ];
    (getToolExecutionForWorker as jest.Mock).mockResolvedValue({
      id: EXECUTION_ID,
      sessionId: SESSION_ID,
      toolCallId: TOOL_CALL_ID,
      toolName: "generateWorkflow",
      status: "PENDING",
      input: cycleProposal(),
      session: {
        status: "RUNNING",
        currentStep: 2,
        orgId: "org_1",
        userId: "user_a",
      },
    });
    (markToolExecutionRunning as jest.Mock).mockResolvedValue(true);
    (heartbeatToolExecution as jest.Mock).mockResolvedValue(true);
  });

  it("persists the failure under the exact toolCallId and continues the loop", async () => {
    await handleToolExecution({
      event: {
        data: {
          sessionId: SESSION_ID,
          executionId: EXECUTION_ID,
          expectedStep: 3,
        },
      },
    } as never);

    const [message] = (createMessage as jest.Mock).mock.calls[0]!;
    const value = jsonValue(message.message.content[0].output);

    expect(message.toolCallId).toBe(TOOL_CALL_ID);
    expect(message.message.content[0].toolName).toBe("generateWorkflow");
    expect(value.ok).toBe(false);
    expect(value.code).toBe("INVALID_INPUT");
    expect(value.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "CYCLE", path: "steps" }),
      ]),
    );

    // The result is durable together with the intent to re-drive the loop, so a
    // failed proposal can be corrected on the next turn.
    expect(recordAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "AGENT_LOOP_REQUESTED",
        payload: expect.objectContaining({ sessionId: SESSION_ID }),
      }),
    );
    // F-1: the terminal status commits with the result in the worker's own
    // transaction, not in a separate post-transaction write.
    expect(store.executions[0]!.status).toBe("COMPLETED");
  });
});
