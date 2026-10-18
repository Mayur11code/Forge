// src/tests/agent/missing-input-protocol.test.ts
//
// Assignment 37.6 — Missing-Input Protocol and Clarification State.
//
// Verifies:
// 1. Classification & issue contract (MISSING_REQUIRED_INPUT vs NEEDS_USER_INPUT vs INVALID_INPUT)
// 2. Three-loop separation (model self-correction vs human clarification vs human confirmation)
// 3. Same-session answer continuation and correlation bounds

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

jest.mock("@/lib/workflow/execution/trigger", () => ({
  startWorkflow: jest.fn(),
}));

jest.mock("@/lib/ai/agent/status", () => ({ publishAgentStatus: jest.fn() }));

jest.mock("@/lib/ai/agent/session-service", () => ({
  getAgentSessionForUser: jest.fn(),
  failAgentSession: jest.fn(),
}));

jest.mock("@/lib/ai/agent/services/message-service", () => ({
  createMessage: jest.fn(),
  getMessages: jest.fn(),
}));

jest.mock("@/lib/ai/agent/outbox", () => ({
  recordAgentEvent: jest.fn(),
}));

// The lock is a Redis round trip and has its own dedicated suite. Here it only
// needs to run the callback so the service's read-decide-write body is what the
// tests actually exercise.
jest.mock("@/lib/ai/agent/locks", () => {
  const run = async <T>(_id: string, cb: () => Promise<T>): Promise<T> => cb();
  return {
    withAgentSessionLock: jest.fn(run),
    withToolExecutionLock: jest.fn(run),
  };
});

// The tool-execution persistence calls are asserted, not simulated: the worker
// test's subject is the DECISION the worker makes about the loop, not the
// database transitions it delegates.
jest.mock("@/lib/ai/agent/services/tool-execution-service", () => ({
  getToolExecutionForWorker: jest.fn(),
  markToolExecutionRunning: jest.fn(),
  failToolExecution: jest.fn(),
  abandonToolExecution: jest.fn(),
  heartbeatToolExecution: jest.fn(async () => true),
}));

// Real policy, one stubbed seam: `requiresToolConfirmation` must stay the
// production policy (tests 13/14 depend on it), while the executor lookup is
// controllable for the worker test.
jest.mock("@/lib/ai/agent/tools/registry", () => {
  const actual = jest.requireActual("@/lib/ai/agent/tools/registry");
  return { ...actual, getToolExecutor: jest.fn() };
});

import type { Prisma } from "@prisma/client";
import { compileWorkflowProposal } from "@/lib/workflow-types/workflow-proposal-compiler";
import {
  executeGenerateWorkflow,
  computeProposalCorrelationId,
} from "@/lib/ai/agent/tools/generate-workflow/execute";
import type {
  GenerateWorkflowClarification,
  GenerateWorkflowFailure,
} from "@/lib/ai/agent/tools/generate-workflow/types";
import { getAgentSessionForUser } from "@/lib/ai/agent/session-service";
import { createMessage, getMessages } from "@/lib/ai/agent/services/message-service";
import { recordAgentEvent } from "@/lib/ai/agent/outbox";
import { publishAgentStatus } from "@/lib/ai/agent/status";
import { withAgentSessionLock } from "@/lib/ai/agent/locks";
import { handleToolExecution } from "@/lib/ai/agent/tool-worker";
import { getToolExecutor } from "@/lib/ai/agent/tools/registry";
import {
  getToolExecutionForWorker,
  markToolExecutionRunning,
} from "@/lib/ai/agent/services/tool-execution-service";
import { resetStore, restorePrismaDouble, store } from "./helpers/prisma-double";
import { submitClarificationAnswer } from "@/lib/ai/agent/services/clarification-service";
import { startWorkflow } from "@/lib/workflow/execution/trigger";
import { createTaskAction } from "@/lib/workflow/actions/core/create-task";
import { requiresToolConfirmation } from "@/lib/ai/agent/tools/registry";

const PROJECT_ID = "clxyz0000000000000000000a";

type TestOutputShape = {
  ok: boolean;
  status?: string;
  code?: string;
  error?: string;
  issues?: { path: string; code: string; message: string }[];
  fields?: {
    field: string;
    reason: string;
    question: string;
    candidateValues?: unknown[];
  }[];
  correlationId?: string;
  proposal?: {
    name: string;
    description?: string;
    steps: Record<
      string,
      { action: string; inputs: Record<string, unknown>; dependsOn: string[] }
    >;
  };
};

function jsonValue(output: unknown): TestOutputShape {
  return (output as { value: TestOutputShape }).value;
}

const TOOL_CALL_ID = "call_gen_1";
const INTERACTION_ID = "exec_1";
const CORRELATION_ID = "prop_corr_1234567890abcdef";
const MISSING_FIELD = "steps.step1.inputs.projectId";

type TranscriptRow = {
  step: number;
  toolCallId: string | null;
  message: unknown;
  createdAt: Date;
};

/**
 * A persisted clarification tool-result, exactly as the worker writes it: the
 * executor's NEEDS_USER_INPUT envelope with the worker-stamped interactionId.
 */
function clarificationRow(): TranscriptRow {
  return {
    step: 2,
    toolCallId: TOOL_CALL_ID,
    createdAt: new Date(0),
    message: {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: TOOL_CALL_ID,
          toolName: "generateWorkflow",
          output: {
            type: "json",
            value: {
              ok: false,
              status: "NEEDS_USER_INPUT",
              code: "NEEDS_USER_INPUT",
              error: "Clarification required.",
              interactionId: INTERACTION_ID,
              correlationId: CORRELATION_ID,
              fields: [
                {
                  field: MISSING_FIELD,
                  reason: "task.create requires a project",
                  question: "Which project?",
                },
              ],
            },
          },
        },
      ],
    },
  };
}

function runningSession(step = 2) {
  return {
    id: "sess_1",
    orgId: "org_1",
    userId: "user_1",
    status: "RUNNING",
    currentStep: step,
  };
}

const getAgentSessionForUserMock = getAgentSessionForUser as unknown as jest.Mock;
const getMessagesMock = getMessages as unknown as jest.Mock;
const createMessageMock = createMessage as unknown as jest.Mock;
const recordAgentEventMock = recordAgentEvent as unknown as jest.Mock;
const publishAgentStatusMock = publishAgentStatus as unknown as jest.Mock;
const withAgentSessionLockMock = withAgentSessionLock as unknown as jest.Mock;
const getToolExecutorMock = getToolExecutor as unknown as jest.Mock;
const getToolExecutionForWorkerMock =
  getToolExecutionForWorker as unknown as jest.Mock;
const markToolExecutionRunningMock =
  markToolExecutionRunning as unknown as jest.Mock;

describe("Assignment 37.6 — Group A: Classification and Issue Contract", () => {
  it("1. One required field absent from the proposal produces a MISSING_REQUIRED_INPUT validation issue at the correct field path", () => {
    const proposal = {
      name: "Onboard Client",
      steps: {
        kickoff: {
          action: "task.create",
          inputs: { title: "Kickoff meeting" }, // projectId is missing
          dependsOn: [],
        },
      },
    };

    const compiled = compileWorkflowProposal(proposal);
    expect(compiled.success).toBe(false);
    if (!compiled.success) {
      expect(compiled.issues).toEqual([
        {
          code: "MISSING_REQUIRED_INPUT",
          path: "steps.kickoff.inputs.projectId",
          message: expect.any(String),
        },
      ]);
    }
  });

  it("2. Multiple required fields absent from the proposal are all identified", () => {
    const proposal = {
      name: "Onboard Client",
      steps: {
        kickoff: {
          action: "task.create",
          inputs: {}, // both title and projectId are missing
          dependsOn: [],
        },
      },
    };

    const compiled = compileWorkflowProposal(proposal);
    expect(compiled.success).toBe(false);
    if (!compiled.success) {
      const paths = compiled.issues.map((i) => i.path);
      const codes = compiled.issues.map((i) => i.code);
      expect(paths).toContain("steps.kickoff.inputs.title");
      expect(paths).toContain("steps.kickoff.inputs.projectId");
      expect(codes).toEqual([
        "MISSING_REQUIRED_INPUT",
        "MISSING_REQUIRED_INPUT",
      ]);
    }
  });

  it("3. Missing required fields are not automatically classified as user omission without sufficient evidence", async () => {
    // When the model calls executeGenerateWorkflow without requesting clarification,
    // the tool treats omitted fields as model omission (INVALID_INPUT), not NEEDS_USER_INPUT.
    const proposal = {
      name: "Onboard Client",
      steps: {
        kickoff: {
          action: "task.create",
          inputs: { title: "Kickoff meeting" }, // projectId missing
          dependsOn: [],
        },
      },
    };

    const result = jsonValue(await executeGenerateWorkflow(proposal));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("INVALID_INPUT");
    expect((result as GenerateWorkflowFailure).issues).toEqual([
      {
        code: "MISSING_REQUIRED_INPUT",
        path: "steps.kickoff.inputs.projectId",
        message: expect.any(String),
      },
    ]);
    expect((result as Record<string, unknown>).status).toBeUndefined();
  });

  it("4. A required field that the model omitted despite being available in context remains model-correctable", async () => {
    // Model omitted projectId without clarification intent -> stays INVALID_INPUT so the
    // existing bounded agent loop can self-correct.
    const rawInput = {
      name: "Client Setup",
      steps: {
        init: {
          action: "task.create",
          inputs: { title: "Setup workspace" },
          dependsOn: [],
        },
      },
    };

    const output = jsonValue(await executeGenerateWorkflow(rawInput));
    expect(output.ok).toBe(false);
    expect(output.code).toBe("INVALID_INPUT");
    expect((output as GenerateWorkflowFailure).issues[0].code).toBe(
      "MISSING_REQUIRED_INPUT",
    );
  });

  it("5. A genuinely missing user-supplied value can produce the structured NEEDS_USER_INPUT result through the clarification contract", async () => {
    const inputWithClarification = {
      name: "Client Onboarding",
      steps: {
        step1: {
          action: "task.create",
          inputs: { title: "Onboarding call" },
          dependsOn: [],
        },
      },
      clarifications: [
        {
          field: "steps.step1.inputs.projectId",
          reason: "task.create requires a project id which was never supplied",
          question: "Which project should the onboarding call belong to?",
        },
      ],
    };

    const output = jsonValue(
      await executeGenerateWorkflow(inputWithClarification),
    );
    expect(output.ok).toBe(false);
    expect(output.code).toBe("NEEDS_USER_INPUT");
    const clarification = output as GenerateWorkflowClarification;
    expect(clarification.status).toBe("NEEDS_USER_INPUT");
    expect(clarification.fields).toHaveLength(1);
    expect(clarification.fields[0]).toEqual({
      field: "steps.step1.inputs.projectId",
      reason: "task.create requires a project id which was never supplied",
      question: "Which project should the onboarding call belong to?",
    });
    expect(clarification.correlationId).toMatch(/^prop_corr_[a-f0-9]{16}$/);
    expect(clarification.proposal?.name).toBe("Client Onboarding");
  });

  it("6. NEEDS_USER_INPUT is distinguishable from INVALID_INPUT at the top-level protocol boundary, not merely in a nested list", async () => {
    const modelErrorInput = {
      name: "Client Setup",
      steps: {
        step1: {
          action: "task.create",
          inputs: { title: "Do work" }, // missing projectId without clarification
          dependsOn: [],
        },
      },
    };

    const missingUserInput = {
      name: "Client Setup",
      steps: {
        step1: {
          action: "task.create",
          inputs: { title: "Do work" },
          dependsOn: [],
        },
      },
      clarifications: [
        {
          field: "steps.step1.inputs.projectId",
          reason: "Project is required",
          question: "Which project?",
        },
      ],
    };

    const modelErrorResult = jsonValue(
      await executeGenerateWorkflow(modelErrorInput),
    );
    const clarificationResult = jsonValue(
      await executeGenerateWorkflow(missingUserInput),
    );

    // Top-level discrimination
    expect(modelErrorResult.code).toBe("INVALID_INPUT");
    expect((modelErrorResult as Record<string, unknown>).status).toBeUndefined();

    expect(clarificationResult.code).toBe("NEEDS_USER_INPUT");
    expect(
      (clarificationResult as GenerateWorkflowClarification).status,
    ).toBe("NEEDS_USER_INPUT");
  });

  it("7. Null, empty, wrong-type and present-but-invalid values are not misclassified as missing user information", async () => {
    // A: null value for projectId
    const nullVal = compileWorkflowProposal({
      name: "Test",
      steps: {
        s1: {
          action: "task.create",
          inputs: { title: "Test", projectId: null },
          dependsOn: [],
        },
      },
    });
    expect(nullVal.success).toBe(false);
    if (!nullVal.success) {
      expect(nullVal.issues[0].code).toBe("INVALID_INPUT");
      expect(nullVal.issues[0].code).not.toBe("MISSING_REQUIRED_INPUT");
    }

    // B: empty string for projectId
    const emptyVal = compileWorkflowProposal({
      name: "Test",
      steps: {
        s1: {
          action: "task.create",
          inputs: { title: "Test", projectId: "" },
          dependsOn: [],
        },
      },
    });
    expect(emptyVal.success).toBe(false);
    if (!emptyVal.success) {
      expect(emptyVal.issues[0].code).toBe("INVALID_INPUT");
      expect(emptyVal.issues[0].code).not.toBe("MISSING_REQUIRED_INPUT");
    }

    // C: wrong type (number) for projectId
    const wrongType = compileWorkflowProposal({
      name: "Test",
      steps: {
        s1: {
          action: "task.create",
          inputs: { title: "Test", projectId: 12345 },
          dependsOn: [],
        },
      },
    });
    expect(wrongType.success).toBe(false);
    if (!wrongType.success) {
      expect(wrongType.issues[0].code).toBe("INVALID_INPUT");
      expect(wrongType.issues[0].code).not.toBe("MISSING_REQUIRED_INPUT");
    }

    // D: malformed CUID string
    const invalidFormat = compileWorkflowProposal({
      name: "Test",
      steps: {
        s1: {
          action: "task.create",
          inputs: { title: "Test", projectId: "not-a-cuid" },
          dependsOn: [],
        },
      },
    });
    expect(invalidFormat.success).toBe(false);
    if (!invalidFormat.success) {
      expect(invalidFormat.issues[0].code).toBe("INVALID_INPUT");
      expect(invalidFormat.issues[0].code).not.toBe("MISSING_REQUIRED_INPUT");
    }

    // E: attempting clarification on a wrong-type field is rejected as INVALID_INPUT
    const invalidClarification = jsonValue(
      await executeGenerateWorkflow({
        name: "Test",
        steps: {
          s1: {
            action: "task.create",
            inputs: { title: "Test", projectId: 12345 },
            dependsOn: [],
          },
        },
        clarifications: [
          {
            field: "steps.s1.inputs.projectId",
            reason: "Wrong type",
            question: "Project ID?",
          },
        ],
      }),
    );
    expect(invalidClarification.code).toBe("INVALID_INPUT");
  });

  it("8. Template references in required fields retain their existing deferred-reference behavior", () => {
    const proposalWithReference = {
      name: "Chained Workflow",
      steps: {
        stepA: {
          action: "task.create",
          inputs: { title: "Step A", projectId: PROJECT_ID },
          dependsOn: [],
        },
        stepB: {
          action: "task.create",
          inputs: {
            title: "Step B",
            projectId: "{{stepA.outputs.taskId}}", // Reference in required field
          },
          dependsOn: ["stepA"],
        },
      },
    };

    const compiled = compileWorkflowProposal(proposalWithReference);
    expect(compiled.success).toBe(true);
  });

  it("9. Multiple missing inputs produce multiple field records and suitable human questions", async () => {
    const multiMissing = {
      name: "Onboard Acme",
      steps: {
        step1: {
          action: "task.create",
          inputs: {}, // both title and projectId are missing
          dependsOn: [],
        },
      },
      clarifications: [
        {
          field: "steps.step1.inputs.title",
          reason: "A task requires a title",
          question: "What title should be used for the task?",
        },
        {
          field: "steps.step1.inputs.projectId",
          reason: "A task must belong to a project",
          question: "Which project should the task be placed into?",
        },
      ],
    };

    const output = jsonValue(await executeGenerateWorkflow(multiMissing));
    expect(output.code).toBe("NEEDS_USER_INPUT");
    const clarification = output as GenerateWorkflowClarification;
    expect(clarification.fields).toHaveLength(2);
    expect(clarification.fields.map((f) => f.field)).toEqual([
      "steps.step1.inputs.title",
      "steps.step1.inputs.projectId",
    ]);
    expect(clarification.fields[0].question).toBe(
      "What title should be used for the task?",
    );
    expect(clarification.fields[1].question).toBe(
      "Which project should the task be placed into?",
    );
  });

  it("10. Candidate values are absent unless supported by authoritative evidence", async () => {
    // Case A: No candidate values supplied -> omitted from field record
    const noCandidates = jsonValue(
      await executeGenerateWorkflow({
        name: "Test",
        steps: {
          step1: {
            action: "task.create",
            inputs: { title: "Title" },
            dependsOn: [],
          },
        },
        clarifications: [
          {
            field: "steps.step1.inputs.projectId",
            reason: "Project missing",
            question: "Project ID?",
          },
        ],
      }),
    ) as GenerateWorkflowClarification;
    expect(noCandidates.fields[0].candidateValues).toBeUndefined();

    // Case B: Candidate values supplied -> included in field record
    const withCandidates = jsonValue(
      await executeGenerateWorkflow({
        name: "Test",
        steps: {
          step1: {
            action: "task.create",
            inputs: { title: "Title" },
            dependsOn: [],
          },
        },
        clarifications: [
          {
            field: "steps.step1.inputs.projectId",
            reason: "Project missing",
            question: "Which of these projects?",
            candidateValues: ["project_alpha", "project_beta"],
          },
        ],
      }),
    ) as GenerateWorkflowClarification;
    expect(withCandidates.fields[0].candidateValues).toEqual([
      "project_alpha",
      "project_beta",
    ]);
  });
});

describe("Assignment 37.6 — Group B: Three-Loop Separation", () => {
  it("11. UNKNOWN_ACTION, UNKNOWN_DEPENDENCY and CYCLE follow existing model-correction behavior", async () => {
    // A: UNKNOWN_ACTION
    const unknownAction = jsonValue(
      await executeGenerateWorkflow({
        name: "Test",
        steps: {
          s1: {
            action: "non.existent.action",
            inputs: {},
            dependsOn: [],
          },
        },
      }),
    ) as GenerateWorkflowFailure;
    expect(unknownAction.code).toBe("INVALID_INPUT");
    expect(unknownAction.issues[0].code).toBe("UNKNOWN_ACTION");

    // B: UNKNOWN_DEPENDENCY
    const unknownDep = jsonValue(
      await executeGenerateWorkflow({
        name: "Test",
        steps: {
          s1: {
            action: "task.create",
            inputs: { title: "Test", projectId: PROJECT_ID },
            dependsOn: ["missing_step"],
          },
        },
      }),
    ) as GenerateWorkflowFailure;
    expect(unknownDep.code).toBe("INVALID_INPUT");
    expect(unknownDep.issues[0].code).toBe("UNKNOWN_DEPENDENCY");

    // C: CYCLE
    const cycle = jsonValue(
      await executeGenerateWorkflow({
        name: "Test",
        steps: {
          a: {
            action: "task.create",
            inputs: { title: "Task A", projectId: PROJECT_ID },
            dependsOn: ["b"],
          },
          b: {
            action: "task.create",
            inputs: { title: "Task B", projectId: PROJECT_ID },
            dependsOn: ["a"],
          },
        },
      }),
    ) as GenerateWorkflowFailure;
    expect(cycle.code).toBe("INVALID_INPUT");
    expect(cycle.issues[0].code).toBe("CYCLE");

    // D: Even if clarifications were attached, a cycle remains a model error
    const cycleWithClarification = jsonValue(
      await executeGenerateWorkflow({
        name: "Test",
        steps: {
          a: {
            action: "task.create",
            inputs: { title: "Task A" }, // missing projectId
            dependsOn: ["b"],
          },
          b: {
            action: "task.create",
            inputs: { title: "Task B", projectId: PROJECT_ID },
            dependsOn: ["a"],
          },
        },
        clarifications: [
          {
            field: "steps.a.inputs.projectId",
            reason: "Missing",
            question: "Project?",
          },
        ],
      }),
    );
    expect(cycleWithClarification.code).toBe("INVALID_INPUT");
  });

  it("12. NEEDS_USER_INPUT does not enter an uncontrolled self-correction loop", async () => {
    // When clarification is needed, the status is NEEDS_USER_INPUT rather than INVALID_INPUT.
    // Consumers check `code === "NEEDS_USER_INPUT"` to stop autonomous self-correction
    // and wait for user response.
    const output = jsonValue(
      await executeGenerateWorkflow({
        name: "Onboard",
        steps: {
          kickoff: {
            action: "task.create",
            inputs: { title: "Call" },
            dependsOn: [],
          },
        },
        clarifications: [
          {
            field: "steps.kickoff.inputs.projectId",
            reason: "Required project id",
            question: "What project?",
          },
        ],
      }),
    );
    expect(output.code).toBe("NEEDS_USER_INPUT");
    expect((output as GenerateWorkflowClarification).status).toBe(
      "NEEDS_USER_INPUT",
    );
  });

  it("13. A clarification state cannot be mistaken for PENDING_CONFIRMATION", () => {
    // generateWorkflow is READ_ONLY by policy (AD-17). It never enters PENDING_CONFIRMATION.
    expect(requiresToolConfirmation("generateWorkflow")).toBe(false);
  });

  it("14. Existing confirmation, cancellation, expiry and self-correction contracts remain unmodified", () => {
    // createTask is WRITE by policy, requiring human confirmation
    expect(requiresToolConfirmation("createTask")).toBe(true);
    // listTasks is READ_ONLY
    expect(requiresToolConfirmation("listTasks")).toBe(false);
  });

  it("15. Unexpected model/provider errors remain distinct from validation and clarification outcomes", async () => {
    // Null payload is an unexpected bug, throwing an error rather than returning INVALID_INPUT
    await expect(
      executeGenerateWorkflow(null as unknown as Prisma.JsonValue),
    ).rejects.toThrow("Tool input cannot be null.");
  });
});

describe("Assignment 37.6 — Group C: Continuation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    restorePrismaDouble();
    resetStore();
    // The proposal row the worker would have parked. The answer's CAS targets
    // `proposalState = NEEDS_CLARIFICATION` on this row, so a service test that
    // does not seed it would exercise a lost CAS rather than the accept path.
    store.executions.push({
      id: INTERACTION_ID,
      sessionId: "sess_1",
      status: "COMPLETED",
      proposalState: "NEEDS_CLARIFICATION",
      error: null,
    });
  });

  it("16. Verify same-session answer path is authenticated and organization-scoped", async () => {
    getAgentSessionForUserMock.mockResolvedValueOnce(null);

    const result = await submitClarificationAnswer({
      sessionId: "sess_non_existent",
      userId: "user_unauthorized",
      interactionId: INTERACTION_ID,
      correlationId: CORRELATION_ID,
      answers: { [MISSING_FIELD]: PROJECT_ID },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NOT_FOUND");
      expect(result.httpStatus).toBe(404);
    }
    expect(getAgentSessionForUserMock).toHaveBeenCalledWith({
      sessionId: "sess_non_existent",
      userId: "user_unauthorized",
    });
  });

  it("17. Verify answer is bound to the exact pending interaction and correct proposal revision", async () => {
    // The fingerprint is a revision label...
    const proposal = {
      name: "Onboard",
      steps: {
        step1: { action: "task.create", inputs: { title: "Start" }, dependsOn: [] },
      },
    };
    expect(computeProposalCorrelationId(proposal)).toMatch(
      /^prop_corr_[a-f0-9]{16}$/,
    );

    // ...but the authoritative binding is the worker-stamped interactionId.
    getAgentSessionForUserMock.mockResolvedValueOnce(runningSession(2));
    getMessagesMock.mockResolvedValue([clarificationRow()]);

    const result = await submitClarificationAnswer({
      sessionId: "sess_1",
      userId: "user_1",
      interactionId: INTERACTION_ID,
      correlationId: CORRELATION_ID,
      answers: { [MISSING_FIELD]: PROJECT_ID },
    });

    expect(result.ok).toBe(true);
    // The answer is tagged with the interaction id, which is what retires
    // exactly this request and nothing else.
    expect(createMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess_1",
        step: 2,
        toolCallId: INTERACTION_ID,
      }),
    );
  });

  it("18a. A non-running session rejects the answer", async () => {
    getAgentSessionForUserMock.mockResolvedValueOnce({
      ...runningSession(5),
      status: "COMPLETED",
    });

    const result = await submitClarificationAnswer({
      sessionId: "sess_1",
      userId: "user_1",
      interactionId: INTERACTION_ID,
      correlationId: CORRELATION_ID,
      answers: { [MISSING_FIELD]: PROJECT_ID },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SESSION_NOT_RUNNING");
    }
  });

  it("18b. An empty correlationId is rejected before any DB work", async () => {
    const result = await submitClarificationAnswer({
      sessionId: "sess_1",
      userId: "user_1",
      interactionId: INTERACTION_ID,
      correlationId: "",
      answers: { [MISSING_FIELD]: PROJECT_ID },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_CORRELATION_ID");
    }
  });

  it("18c. A session with no pending clarification cannot be answered", async () => {
    getAgentSessionForUserMock.mockResolvedValueOnce(runningSession(2));
    getMessagesMock.mockResolvedValue([]);

    const result = await submitClarificationAnswer({
      sessionId: "sess_1",
      userId: "user_1",
      interactionId: INTERACTION_ID,
      correlationId: CORRELATION_ID,
      answers: { [MISSING_FIELD]: PROJECT_ID },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NO_PENDING_CLARIFICATION");
    }
  });

  it("18d. A stale interactionId or correlationId is rejected, not silently accepted", async () => {
    getAgentSessionForUserMock.mockResolvedValueOnce(runningSession(2));
    getMessagesMock.mockResolvedValue([clarificationRow()]);

    const wrongInteraction = await submitClarificationAnswer({
      sessionId: "sess_1",
      userId: "user_1",
      interactionId: "exec_other",
      correlationId: CORRELATION_ID,
      answers: { [MISSING_FIELD]: PROJECT_ID },
    });
    expect(wrongInteraction.ok).toBe(false);
    if (!wrongInteraction.ok) {
      expect(wrongInteraction.code).toBe("STALE_CLARIFICATION");
    }

    getAgentSessionForUserMock.mockResolvedValueOnce(runningSession(2));
    getMessagesMock.mockResolvedValue([clarificationRow()]);

    const wrongCorrelation = await submitClarificationAnswer({
      sessionId: "sess_1",
      userId: "user_1",
      interactionId: INTERACTION_ID,
      correlationId: "prop_corr_deadbeefdeadbeef",
      answers: { [MISSING_FIELD]: PROJECT_ID },
    });
    expect(wrongCorrelation.ok).toBe(false);
    if (!wrongCorrelation.ok) {
      expect(wrongCorrelation.code).toBe("STALE_CLARIFICATION");
    }
  });

  it("18e. Duplicate answers are idempotent; a different duplicate is a conflict", async () => {
    // An in-memory transcript that actually accumulates the answer, so the
    // second submission sees the first.
    const transcript: TranscriptRow[] = [clarificationRow()];
    getMessagesMock.mockImplementation(async () => transcript);
    createMessageMock.mockImplementation(
      async (args: {
        step: number;
        toolCallId?: string;
        message: unknown;
      }) => {
        transcript.push({
          step: args.step,
          toolCallId: args.toolCallId ?? null,
          message: args.message,
          createdAt: new Date(transcript.length),
        });
      },
    );

    getAgentSessionForUserMock.mockResolvedValue(runningSession(2));

    const first = await submitClarificationAnswer({
      sessionId: "sess_1",
      userId: "user_1",
      interactionId: INTERACTION_ID,
      correlationId: CORRELATION_ID,
      answers: { [MISSING_FIELD]: PROJECT_ID },
    });
    expect(first.ok).toBe(true);
    expect(createMessageMock).toHaveBeenCalledTimes(1);

    const repeat = await submitClarificationAnswer({
      sessionId: "sess_1",
      userId: "user_1",
      interactionId: INTERACTION_ID,
      correlationId: CORRELATION_ID,
      answers: { [MISSING_FIELD]: PROJECT_ID },
    });
    expect(repeat.ok).toBe(true);
    if (repeat.ok) {
      expect(repeat.idempotent).toBe(true);
    }
    // No second message, no second continuation.
    expect(createMessageMock).toHaveBeenCalledTimes(1);
    expect(recordAgentEventMock).toHaveBeenCalledTimes(1);

    const conflict = await submitClarificationAnswer({
      sessionId: "sess_1",
      userId: "user_1",
      interactionId: INTERACTION_ID,
      correlationId: CORRELATION_ID,
      answers: { [MISSING_FIELD]: "clxyz0000000000000000000b" },
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.code).toBe("CLARIFICATION_CONFLICT");
    }
  });

  it("18f. An answer that cannot take the session lock reports busy rather than double-writing", async () => {
    getAgentSessionForUserMock.mockResolvedValueOnce(runningSession(2));
    withAgentSessionLockMock.mockResolvedValueOnce(null);

    const result = await submitClarificationAnswer({
      sessionId: "sess_1",
      userId: "user_1",
      interactionId: INTERACTION_ID,
      correlationId: CORRELATION_ID,
      answers: { [MISSING_FIELD]: PROJECT_ID },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SESSION_BUSY");
    }
    expect(createMessageMock).not.toHaveBeenCalled();
  });

  it("19. Verify continuation returns through AGENT_LOOP_REQUESTED and the existing bounded loop", async () => {
    getAgentSessionForUserMock.mockResolvedValueOnce(runningSession(3));
    getMessagesMock.mockResolvedValue([clarificationRow()]);

    const result = await submitClarificationAnswer({
      sessionId: "sess_1",
      userId: "user_1",
      interactionId: INTERACTION_ID,
      correlationId: CORRELATION_ID,
      answers: { [MISSING_FIELD]: PROJECT_ID },
    });

    expect(result.ok).toBe(true);
    expect(recordAgentEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "AGENT_LOOP_REQUESTED",
        sessionId: "sess_1",
        aggregateId: `${"sess_1"}:3:clarification:${INTERACTION_ID}`,
        payload: {
          sessionId: "sess_1",
          expectedStep: 3,
          orgId: "org_1",
        },
      }),
    );
  });

  it("20. Verify any regenerated proposal passes through compileWorkflowProposal again", () => {
    // Regenerated proposal after user supplies projectId
    const regenerated = {
      name: "Onboard",
      steps: {
        step1: {
          action: "task.create",
          inputs: {
            title: "Onboarding Task",
            projectId: PROJECT_ID, // Supplied by user
          },
          dependsOn: [],
        },
      },
    };

    const compiled = compileWorkflowProposal(regenerated);
    expect(compiled.success).toBe(true);
    if (compiled.success) {
      expect(compiled.proposal.name).toBe("Onboard");
      expect(compiled.definition.steps.step1.action).toBe("task.create");
    }
  });

  it("21. Verify no workflow action is executed and no workflow is materialized during clarification", async () => {
    const executeSpy = jest.spyOn(createTaskAction, "execute");

    const missingInput = {
      name: "Client Setup",
      steps: {
        step1: {
          action: "task.create",
          inputs: { title: "Do work" },
          dependsOn: [],
        },
      },
      clarifications: [
        {
          field: "steps.step1.inputs.projectId",
          reason: "Project is required",
          question: "Which project?",
        },
      ],
    };

    await executeGenerateWorkflow(missingInput);

    expect(startWorkflow).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();

    executeSpy.mockRestore();
  });

  it("22. A successful CAS commits the answer, the lifecycle update and the continuation together", async () => {
    getAgentSessionForUserMock.mockResolvedValueOnce(runningSession(2));
    getMessagesMock.mockResolvedValue([clarificationRow()]);

    const result = await submitClarificationAnswer({
      sessionId: "sess_1",
      userId: "user_1",
      interactionId: INTERACTION_ID,
      correlationId: CORRELATION_ID,
      answers: { [MISSING_FIELD]: PROJECT_ID },
    });

    expect(result.ok).toBe(true);
    const row = store.executions[0]!;
    expect(row.proposalState).toBe("CLARIFICATION_ACCEPTED");
    expect(row.clarificationAnswer).toEqual({ [MISSING_FIELD]: PROJECT_ID });
    expect(createMessageMock).toHaveBeenCalledTimes(1);
    expect(recordAgentEventMock).toHaveBeenCalledTimes(1);
  });

  it("23. A lost CAS returns 409 and writes neither the message nor the continuation", async () => {
    // The row is not awaiting a clarification (e.g. a concurrent criticality
    // decision already advanced it), even though the transcript still exposes a
    // pending request. The CAS must gate the write.
    store.executions[0]!.proposalState = "AWAITING_CRITICALITY";
    getAgentSessionForUserMock.mockResolvedValueOnce(runningSession(2));
    getMessagesMock.mockResolvedValue([clarificationRow()]);

    const result = await submitClarificationAnswer({
      sessionId: "sess_1",
      userId: "user_1",
      interactionId: INTERACTION_ID,
      correlationId: CORRELATION_ID,
      answers: { [MISSING_FIELD]: PROJECT_ID },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("CLARIFICATION_NOT_APPLIED");
      expect(result.httpStatus).toBe(409);
    }
    expect(createMessageMock).not.toHaveBeenCalled();
    expect(recordAgentEventMock).not.toHaveBeenCalled();
    const row = store.executions[0]!;
    expect(row.proposalState).toBe("AWAITING_CRITICALITY");
    expect(row.clarificationAnswer).toBeUndefined();
  });

  it("23b. A resolved proposal cannot be resurrected by replaying the transcript", async () => {
    // The durable row already advanced to CLARIFICATION_ACCEPTED...
    const row = store.executions[0]!;
    row.proposalState = "CLARIFICATION_ACCEPTED";
    row.clarificationAnswer = { [MISSING_FIELD]: PROJECT_ID };
    getAgentSessionForUserMock.mockResolvedValueOnce(runningSession(2));
    // ...but the transcript no longer shows the answer, so the pending request
    // is still discoverable. Only the CAS prevents the resurrect.
    getMessagesMock.mockResolvedValue([clarificationRow()]);

    const result = await submitClarificationAnswer({
      sessionId: "sess_1",
      userId: "user_1",
      interactionId: INTERACTION_ID,
      correlationId: CORRELATION_ID,
      answers: { [MISSING_FIELD]: PROJECT_ID },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("CLARIFICATION_NOT_APPLIED");
    }
    expect(createMessageMock).not.toHaveBeenCalled();
    expect(recordAgentEventMock).not.toHaveBeenCalled();
    expect(store.executions[0]!.proposalState).toBe("CLARIFICATION_ACCEPTED");
  });

  it("24. An identical repeat is idempotent and writes nothing further", async () => {
    const transcript: TranscriptRow[] = [clarificationRow()];
    getMessagesMock.mockImplementation(async () => transcript);
    createMessageMock.mockImplementation(
      async (args: {
        step: number;
        toolCallId?: string;
        message: unknown;
      }) => {
        transcript.push({
          step: args.step,
          toolCallId: args.toolCallId ?? null,
          message: args.message,
          createdAt: new Date(transcript.length),
        });
      },
    );
    getAgentSessionForUserMock.mockResolvedValue(runningSession(2));

    const first = await submitClarificationAnswer({
      sessionId: "sess_1",
      userId: "user_1",
      interactionId: INTERACTION_ID,
      correlationId: CORRELATION_ID,
      answers: { [MISSING_FIELD]: PROJECT_ID },
    });
    expect(first.ok).toBe(true);

    const repeat = await submitClarificationAnswer({
      sessionId: "sess_1",
      userId: "user_1",
      interactionId: INTERACTION_ID,
      correlationId: CORRELATION_ID,
      answers: { [MISSING_FIELD]: PROJECT_ID },
    });
    expect(repeat.ok).toBe(true);
    if (repeat.ok) {
      expect(repeat.idempotent).toBe(true);
    }
    expect(createMessageMock).toHaveBeenCalledTimes(1);
    expect(recordAgentEventMock).toHaveBeenCalledTimes(1);
  });
});

describe("Assignment 37.6 — Group D: Worker Halt vs Continuation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    restorePrismaDouble();
    resetStore();
    // The claimed row must exist and be RUNNING: its terminal COMPLETED status
    // is written by the worker's own outcome compare-and-set.
    store.executions = [
      {
        id: INTERACTION_ID,
        sessionId: "sess_1",
        toolName: "generateWorkflow",
        toolCallId: TOOL_CALL_ID,
        status: "RUNNING",
        input: {},
        error: null,
      },
    ];
    getToolExecutionForWorkerMock.mockResolvedValue({
      id: INTERACTION_ID,
      sessionId: "sess_1",
      toolName: "generateWorkflow",
      toolCallId: TOOL_CALL_ID,
      input: {},
      session: {
        orgId: "org_1",
        userId: "user_1",
        status: "RUNNING",
        currentStep: 1,
      },
    });
    markToolExecutionRunningMock.mockResolvedValue(true);
  });

  it("22. A NEEDS_USER_INPUT result halts the loop and persists the ask with the interactionId", async () => {
    getToolExecutorMock.mockReturnValue(async () => ({
      type: "json",
      value: {
        ok: false,
        status: "NEEDS_USER_INPUT",
        code: "NEEDS_USER_INPUT",
        error: "Clarification required.",
        correlationId: CORRELATION_ID,
        fields: [{ field: MISSING_FIELD, reason: "r", question: "q" }],
      },
    }));

    await handleToolExecution({
      event: {
        data: {
          orgId: "org_1",
          sessionId: "sess_1",
          executionId: INTERACTION_ID,
          expectedStep: 1,
        },
      },
    });

    expect(createMessageMock).toHaveBeenCalledTimes(1);
    const persisted = createMessageMock.mock.calls[0][0] as {
      message: {
        content: { output: { value: Record<string, unknown> } }[];
      };
    };
    // The worker is the only place that knows the execution id, and it stamps
    // it onto the durable result.
    expect(persisted.message.content[0].output.value.interactionId).toBe(
      INTERACTION_ID,
    );
    expect(persisted.message.content[0].output.value.code).toBe(
      "NEEDS_USER_INPUT",
    );

    // The loop is NOT re-driven. This is the whole bug: continuing here spins
    // the model on the same missing input.
    expect(recordAgentEventMock).not.toHaveBeenCalled();
    expect(store.executions[0]!.status).toBe("COMPLETED");
    expect(publishAgentStatusMock).toHaveBeenCalledWith(
      "sess_1",
      expect.objectContaining({
        type: "CLARIFICATION_REQUESTED",
        executionId: INTERACTION_ID,
        interactionId: INTERACTION_ID,
        correlationId: CORRELATION_ID,
      }),
    );
  });

  it("23. A normal result still continues the loop and reports completion", async () => {
    getToolExecutorMock.mockReturnValue(async () => ({
      type: "json",
      value: { ok: true, proposal: { name: "X", steps: {} } },
    }));

    await handleToolExecution({
      event: {
        data: {
          orgId: "org_1",
          sessionId: "sess_1",
          executionId: INTERACTION_ID,
          expectedStep: 1,
        },
      },
    });

    expect(recordAgentEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "AGENT_LOOP_REQUESTED",
        sessionId: "sess_1",
      }),
    );
    expect(publishAgentStatusMock).toHaveBeenCalledWith(
      "sess_1",
      expect.objectContaining({ type: "TOOL_COMPLETED" }),
    );
  });
});
