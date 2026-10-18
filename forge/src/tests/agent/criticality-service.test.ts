// src/tests/agent/criticality-service.test.ts
//
// Assignment 37.7 — Human criticality decision service.
//
// The subject is the read-decide-write body of `submitCriticalityDecision`:
// ownership, liveness, proposal recovery from the PERSISTED result, exact
// supersession, idempotency/conflict, and the single durable write. Redis and
// Redis-only concerns (the lock itself) are replaced so the decision logic is
// what is exercised.

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

jest.mock("@/lib/ai/agent/outbox", () => ({ recordAgentEvent: jest.fn() }));
jest.mock("@/lib/ai/agent/status", () => ({ publishAgentStatus: jest.fn() }));

jest.mock("@/lib/ai/agent/session-service", () => ({
  getAgentSessionForUser: jest.fn(),
}));

jest.mock("@/lib/ai/agent/services/message-service", () => ({
  createMessage: jest.fn(),
  getMessages: jest.fn(),
}));

jest.mock("@/lib/ai/agent/services/tool-execution-service", () => ({
  getToolExecutionsForSession: jest.fn(),
}));

// The lock is a Redis round trip with its own suite; here it only needs to run
// the callback so the service's read-decide-write body is what is exercised.
jest.mock("@/lib/ai/agent/locks", () => {
  const run = async <T>(_id: string, cb: () => Promise<T>): Promise<T> => cb();
  return {
    withAgentSessionLock: jest.fn(run),
    withToolExecutionLock: jest.fn(run),
  };
});

import { getAgentSessionForUser } from "@/lib/ai/agent/session-service";
import {
  createMessage,
  getMessages,
} from "@/lib/ai/agent/services/message-service";
import { getToolExecutionsForSession } from "@/lib/ai/agent/services/tool-execution-service";
import { recordAgentEvent } from "@/lib/ai/agent/outbox";
import { withAgentSessionLock } from "@/lib/ai/agent/locks";
import {
  resetStore,
  restorePrismaDouble,
  store,
} from "./helpers/prisma-double";
import {
  CRITICALITY_DECISION_MARKER,
  isCriticalityDecisionContent,
  readCriticalityDecisionRecord,
  submitCriticalityDecision,
} from "@/lib/ai/agent/services/criticality-service";
import { findPendingClarification } from "@/lib/ai/agent/services/clarification-service";
import { computeProposalCorrelationId } from "@/lib/ai/agent/tools/generate-workflow/execute";

const SESSION_ID = "sess_1";
const TARGET_ID = "exec_target";
const TARGET_TOOL_CALL = "call_target";

const PROPOSAL = {
  name: "Onboard",
  steps: {
    setup: {
      action: "task.create",
      inputs: { title: "Setup", projectId: "proj_1" },
      dependsOn: [],
    },
    notify: {
      action: "task.create",
      inputs: { title: "Notify", projectId: "proj_1" },
      dependsOn: ["setup"],
    },
  },
};

type TranscriptRow = {
  step: number;
  toolCallId: string | null;
  message: unknown;
  createdAt: Date;
};

const sessionMock = getAgentSessionForUser as unknown as jest.Mock;
const getMessagesMock = getMessages as unknown as jest.Mock;
const createMessageMock = createMessage as unknown as jest.Mock;
const executionsMock = getToolExecutionsForSession as unknown as jest.Mock;
const recordEventMock = recordAgentEvent as unknown as jest.Mock;
const lockMock = withAgentSessionLock as unknown as jest.Mock;

function runningSession() {
  return {
    id: SESSION_ID,
    orgId: "org_1",
    userId: "user_1",
    status: "RUNNING",
    currentStep: 3,
  };
}

function execution(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_ID,
    toolCallId: TARGET_TOOL_CALL,
    toolName: "generateWorkflow",
    status: "COMPLETED",
    createdAt: new Date(0),
    ...overrides,
  };
}

function proposalRow(
  exec: { toolCallId: string; toolName: string },
  value: unknown = { ok: true, proposal: PROPOSAL },
): TranscriptRow {
  return {
    step: 3,
    toolCallId: exec.toolCallId,
    createdAt: new Date(1),
    message: {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: exec.toolCallId,
          toolName: exec.toolName,
          output: { type: "json", value },
        },
      ],
    },
  };
}

function submit(overrides: Record<string, unknown> = {}) {
  return submitCriticalityDecision({
    sessionId: SESSION_ID,
    userId: "user_1",
    interactionId: TARGET_ID,
    decisions: { setup: true, notify: false },
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  restorePrismaDouble();
  resetStore();
  // The durable decision write is a compare-and-set against the real double, so
  // the proposal row must exist and be awaiting a criticality decision. This is
  // the state the worker leaves behind when it parks a valid proposal.
  store.executions = [
    {
      id: TARGET_ID,
      sessionId: SESSION_ID,
      toolCallId: TARGET_TOOL_CALL,
      toolName: "generateWorkflow",
      status: "COMPLETED",
      proposalState: "AWAITING_CRITICALITY",
      error: null,
    },
  ];
  sessionMock.mockResolvedValue(runningSession());
  getMessagesMock.mockResolvedValue([proposalRow(execution())]);
  executionsMock.mockResolvedValue([execution()]);
});

describe("37.7 service — authorization and liveness", () => {
  it("rejects a session the caller does not own with 404 and writes nothing", async () => {
    sessionMock.mockResolvedValueOnce(null);

    const result = await submit();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.httpStatus).toBe(404);
      expect(result.code).toBe("INTERACTION_NOT_FOUND");
    }
    expect(createMessageMock).not.toHaveBeenCalled();
  });

  it("rejects a decision on a non-running session", async () => {
    sessionMock.mockResolvedValueOnce({
      ...runningSession(),
      status: "COMPLETED",
    });

    const result = await submit();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SESSION_NOT_RUNNING");
      expect(result.httpStatus).toBe(409);
    }
    expect(createMessageMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed interactionId before any DB work", async () => {
    const result = await submit({ interactionId: "  " });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_REQUEST");
    expect(sessionMock).not.toHaveBeenCalled();
  });
});

describe("37.7 service — proposal recovery", () => {
  it("rejects an unknown interaction id", async () => {
    executionsMock.mockResolvedValue([execution()]);

    const result = await submit({ interactionId: "exec_missing" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INTERACTION_NOT_FOUND");
      expect(result.httpStatus).toBe(404);
    }
  });

  it("rejects an interaction that is not a generateWorkflow proposal", async () => {
    executionsMock.mockResolvedValue([
      execution({ toolName: "createTask" }),
    ]);

    const result = await submit();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOT_A_PROPOSAL");
  });

  it("rejects a generateWorkflow execution whose result is a clarification", async () => {
    getMessagesMock.mockResolvedValue([
      proposalRow(execution(), {
        ok: false,
        status: "NEEDS_USER_INPUT",
        code: "NEEDS_USER_INPUT",
      }),
    ]);

    const result = await submit();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOT_A_PROPOSAL");
    expect(createMessageMock).not.toHaveBeenCalled();
  });

  it("ignores execution.input and recovers the proposal from the persisted result", async () => {
    executionsMock.mockResolvedValue([
      execution({ input: { clarifications: [{ field: "x" }] } }),
    ]);

    const result = await submit();

    expect(result.ok).toBe(true);
  });
});

describe("37.7 service — supersession", () => {
  it("rejects a decision when a LATER successful proposal exists", async () => {
    const later = execution({
      id: "exec_later",
      toolCallId: "call_later",
      createdAt: new Date(10),
    });
    executionsMock.mockResolvedValue([execution(), later]);
    getMessagesMock.mockResolvedValue([
      proposalRow(execution()),
      proposalRow(later),
    ]);

    const result = await submit();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("STALE_CRITICALITY");
      expect(result.httpStatus).toBe(409);
    }
    expect(createMessageMock).not.toHaveBeenCalled();
  });

  it("does NOT treat a later non-proposal execution as superseding", async () => {
    const later = execution({
      id: "exec_later",
      toolCallId: "call_later",
      createdAt: new Date(10),
    });
    executionsMock.mockResolvedValue([execution(), later]);
    getMessagesMock.mockResolvedValue([
      proposalRow(execution()),
      proposalRow(later, { ok: false, code: "INVALID_INPUT" }),
    ]);

    const result = await submit();

    expect(result.ok).toBe(true);
  });
});

describe("37.7 service — decision-set validation", () => {
  it("rejects a set that omits a step", async () => {
    const result = await submit({ decisions: { setup: true } });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INCOMPLETE_CRITICALITY");
      expect(result.httpStatus).toBe(400);
    }
    expect(createMessageMock).not.toHaveBeenCalled();
  });

  it("rejects a set naming a step that is not in the proposal", async () => {
    const result = await submit({
      decisions: { setup: true, notify: false, ghost: true },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNKNOWN_CRITICALITY_STEP");
  });
});

describe("37.7 service — recording, idempotency and conflict", () => {
  it("records the decision once, tagged by the interaction id, with no outbox event", async () => {
    const result = await submit();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessionId).toBe(SESSION_ID);
      expect(result.step).toBe(3);
      expect(result.idempotent).toBeUndefined();
    }

    expect(createMessageMock).toHaveBeenCalledTimes(1);
    const args = createMessageMock.mock.calls[0][0];
    expect(args).toMatchObject({
      sessionId: SESSION_ID,
      step: 3,
      toolCallId: TARGET_ID,
      message: { role: "user" },
    });
    expect(isCriticalityDecisionContent(args.message.content)).toBe(true);
    expect(args.message.content).toContain(
      `${CRITICALITY_DECISION_MARKER}`,
    );

    expect(recordEventMock).not.toHaveBeenCalled();
  });

  it("is idempotent on an identical repeat and a conflict on a changed one", async () => {
    const transcript: TranscriptRow[] = [proposalRow(execution())];
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

    const first = await submit();
    expect(first.ok).toBe(true);
    expect(createMessageMock).toHaveBeenCalledTimes(1);

    const repeat = await submit();
    expect(repeat.ok).toBe(true);
    if (repeat.ok) expect(repeat.idempotent).toBe(true);
    expect(createMessageMock).toHaveBeenCalledTimes(1);

    const conflict = await submit({ decisions: { setup: false, notify: false } });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe("CRITICALITY_CONFLICT");
    expect(createMessageMock).toHaveBeenCalledTimes(1);
  });

  it("rejects with 409 and writes no transcript when the durable CAS is lost (F-4)", async () => {
    // The service saw a valid, non-superseded proposal, but the proposal row
    // advanced underneath it. Honouring the CAS means the transcript must NOT
    // record a decision the lifecycle never took.
    store.executions[0]!.proposalState = "AWAITING_APPROVAL";

    const result = await submit();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.httpStatus).toBe(409);
      expect(result.code).toBe("CRITICALITY_NOT_APPLIED");
    }
    expect(createMessageMock).not.toHaveBeenCalled();
  });

  it("adopts a legacy proposal row that carries no lifecycle state", async () => {
    // A row written before the 37.8 columns existed has a null proposalState.
    // The CAS adopts it rather than refusing a decision that is otherwise valid.
    store.executions[0]!.proposalState = null;

    const result = await submit();

    expect(result.ok).toBe(true);
    expect(store.executions[0]!.proposalState).toBe("AWAITING_APPROVAL");
    expect(createMessageMock).toHaveBeenCalledTimes(1);
  });

  it("reports busy rather than double-writing when the session lock is held", async () => {
    lockMock.mockResolvedValueOnce(null);

    const result = await submit();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SESSION_BUSY");
    expect(createMessageMock).not.toHaveBeenCalled();
  });
});

describe("37.7 service — clarification separation", () => {
  it("does not mistake a decision record for a clarification answer", () => {
    const decisionContent = `${CRITICALITY_DECISION_MARKER}\ninteraction: ${TARGET_ID}\nproposal: prop_corr_x\nsteps:\n- setup: critical`;
    const answerContent =
      `Clarification response for interaction ${TARGET_ID}\ncorrelation: prop_corr_x\n- x: 1`;

    expect(isCriticalityDecisionContent(decisionContent)).toBe(true);
    expect(isCriticalityDecisionContent(answerContent)).toBe(false);
  });

  it("does not retire an unrelated pending clarification", () => {
    const clarificationExec = {
      toolCallId: "call_clar",
      toolName: "generateWorkflow",
    };

    const clarificationRequest: TranscriptRow = {
      step: 2,
      toolCallId: clarificationExec.toolCallId,
      createdAt: new Date(0),
      message: {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: clarificationExec.toolCallId,
            toolName: clarificationExec.toolName,
            output: {
              type: "json",
              value: {
                ok: false,
                status: "NEEDS_USER_INPUT",
                code: "NEEDS_USER_INPUT",
                error: "Clarification required.",
                interactionId: "exec_clar",
                correlationId: "prop_corr_x",
                fields: [
                  { field: "steps.setup.inputs.projectId", reason: "r", question: "q" },
                ],
              },
            },
          },
        ],
      },
    };

    const decisionRecord: TranscriptRow = {
      step: 2,
      toolCallId: TARGET_ID,
      createdAt: new Date(1),
      message: {
        role: "user",
        content: `${CRITICALITY_DECISION_MARKER}\ninteraction: ${TARGET_ID}\nproposal: prop_corr_x\nsteps:\n- setup: critical`,
      },
    };

    const pending = findPendingClarification([
      clarificationRequest,
      decisionRecord,
    ]);

    expect(pending).not.toBeNull();
    expect(pending?.interactionId).toBe("exec_clar");
  });
});

describe("37.7 service — decision record reconstruction", () => {
  it("reads a record back as approved only for the exact proposal revision", () => {
    const fingerprint = computeProposalCorrelationId(PROPOSAL);
    const content = [
      CRITICALITY_DECISION_MARKER,
      `interaction: ${TARGET_ID}`,
      `proposal: ${fingerprint}`,
      "steps:",
      "- notify: not-critical",
      "- setup: critical",
    ].join("\n");

    const exact = readCriticalityDecisionRecord(content, PROPOSAL);
    expect(exact.ok).toBe(true);
    if (exact.ok) {
      expect(exact.approved.decisions).toEqual({ setup: true, notify: false });
    }

    const revisionB = { ...PROPOSAL, description: "Different description." };
    const mismatch = readCriticalityDecisionRecord(content, revisionB);

    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.code).toBe("REVISION_MISMATCH");
  });

  it("rejects a stored record that is not a criticality decision", () => {
    const result = readCriticalityDecisionRecord(
      "Clarification response for interaction exec_target",
      PROPOSAL,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOT_A_DECISION_RECORD");
  });

  it("round-trips the record the service actually wrote", async () => {
    const result = await submit();
    expect(result.ok).toBe(true);

    const written = createMessageMock.mock.calls[0][0].message
      .content as unknown;
    const reconstructed = readCriticalityDecisionRecord(written, PROPOSAL);

    expect(reconstructed.ok).toBe(true);
    if (reconstructed.ok) {
      expect(reconstructed.approved.decisions).toEqual({
        setup: true,
        notify: false,
      });
    }
  });
});
