// src/tests/agent/three-loop-separation.test.ts
//
// Assignment 37.14 — three-loop separation, and the durable session-level
// human-wait marker.
//
// This is the integration/seam suite the phase's verification gate names: it
// exercises the REAL production services (the tool worker, the clarification
// service, the proposal-decision service and the session-lifecycle CAS) against
// the shared prisma double, so the properties under test are the ones the
// deployed code actually holds - not a hand-drawn diagram of them.
//
// The three loops the assignment requires to stay explicitly distinct:
//
//   1. Model self-correction  - a structured validation failure corrects through
//                               the model; the session is NEVER parked.
//   2. Human clarification    - a NEEDS_USER_INPUT result parks the session on a
//                               human; an accepted answer resumes the loop.
//   3. Human approval         - a parked proposal waits on a human decision; the
//                               decision NEVER re-enters the model.
//
// The session status WAITING_CONFIRMATION is only the coarse "a human owes this
// session something" marker. WHICH loop is pending stays distinguishable in the
// authoritative records: the NEEDS_USER_INPUT result (loop 2) versus
// AgentToolExecution.status = PENDING_CONFIRMATION plus the proposal state
// (loop 3). The suite asserts that separation explicitly, and it is designed to
// FAIL if any of the three collapses into the bare session status.

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

jest.mock("@/lib/ai/agent/status", () => ({ publishAgentStatus: jest.fn() }));

jest.mock("@/lib/ai/agent/services/message-service", () => ({
  createMessage: jest.fn(),
  getMessages: jest.fn(),
}));

jest.mock("@/lib/ai/agent/outbox", () => ({
  recordAgentEvent: jest.fn(),
}));

// The lock is a Redis round trip with its own dedicated suite. Here it only has
// to run the callback so the service's real read-decide-write body is what the
// tests exercise.
jest.mock("@/lib/ai/agent/locks", () => {
  const run = async <T>(_id: string, cb: () => Promise<T>): Promise<T> => cb();
  return {
    withAgentSessionLock: jest.fn(run),
    withToolExecutionLock: jest.fn(run),
  };
});

// Session lookups are stubbed so each case can stage the session status it is
// testing; every OTHER session-service export (the wait CAS helpers) stays REAL
// via `requireActual`, so the status transitions are the production ones.
jest.mock("@/lib/ai/agent/session-service", () => {
  const actual = jest.requireActual("@/lib/ai/agent/session-service");
  return {
    ...actual,
    getAgentSessionForUser: jest.fn(),
    getAgentSessionForWorker: jest.fn(),
    failAgentSession: jest.fn(),
  };
});

// The tool-execution persistence the worker delegates is stubbed; the worker's
// SUBJECT here is the decision it makes about the loop and the session status,
// which are the pieces 37.14 changed.
jest.mock("@/lib/ai/agent/services/tool-execution-service", () => ({
  getToolExecutionForWorker: jest.fn(),
  markToolExecutionRunning: jest.fn(),
  failToolExecution: jest.fn(),
  abandonToolExecution: jest.fn(),
  heartbeatToolExecution: jest.fn(async () => true),
  getProposalReviewExecution: jest.fn(),
}));

// Real registry, one controllable seam: the executor lookup.
jest.mock("@/lib/ai/agent/tools/registry", () => {
  const actual = jest.requireActual("@/lib/ai/agent/tools/registry");
  return { ...actual, getToolExecutor: jest.fn() };
});

import { AgentProposalState } from "@prisma/client";

import { handleToolExecution } from "@/lib/ai/agent/tool-worker";
import { getToolExecutor } from "@/lib/ai/agent/tools/registry";
import { computeProposalCorrelationId } from "@/lib/ai/agent/tools/generate-workflow/execute";
import {
  getToolExecutionForWorker,
  markToolExecutionRunning,
} from "@/lib/ai/agent/services/tool-execution-service";
import { getAgentSessionForUser } from "@/lib/ai/agent/session-service";
import { createMessage, getMessages } from "@/lib/ai/agent/services/message-service";
import { recordAgentEvent } from "@/lib/ai/agent/outbox";
import { submitClarificationAnswer } from "@/lib/ai/agent/services/clarification-service";
import { submitProposalDecision } from "@/lib/ai/agent/services/proposal-decision-service";
import {
  resetStore,
  restorePrismaDouble,
  store,
} from "./helpers/prisma-double";

const SESSION_ID = "clxsessionthreeloopaaaaa";
const TOOL_CALL_ID = "call_three_loop_0001";
const USER_ID = "user_owner";
const ORG_ID = "org_1";
const PROJECT_ID = "clxyz0000000000000000000a";
const CORRELATION_ID = "corr_three_loop";

const VALID_PROPOSAL = {
  name: "Onboard a client",
  description: "Kick off the onboarding.",
  steps: {
    kickoff: {
      action: "task.create",
      inputs: { title: "Create the onboarding task", projectId: PROJECT_ID },
      dependsOn: [] as string[],
    },
    follow: {
      action: "task.create",
      inputs: { title: "Follow up on kickoff", projectId: PROJECT_ID },
      dependsOn: ["kickoff"],
    },
  },
};

const getToolExecutorMock = getToolExecutor as jest.MockedFunction<
  typeof getToolExecutor
>;
const getToolExecutionForWorkerMock =
  getToolExecutionForWorker as jest.MockedFunction<
    typeof getToolExecutionForWorker
  >;
const markToolExecutionRunningMock =
  markToolExecutionRunning as jest.MockedFunction<
    typeof markToolExecutionRunning
  >;
const getAgentSessionForUserMock = getAgentSessionForUser as jest.MockedFunction<
  typeof getAgentSessionForUser
>;
const createMessageMock = createMessage as jest.MockedFunction<
  typeof createMessage
>;
const getMessagesMock = getMessages as jest.MockedFunction<typeof getMessages>;
const recordAgentEventMock = recordAgentEvent as jest.MockedFunction<
  typeof recordAgentEvent
>;

/**
 * Stage the session row the REAL wait CAS reads and writes.
 *
 * The helper `markAgentSessionWaiting`/`clearAgentSessionWaiting` resolve
 * through `requireActual`, so their `agentSession.updateMany` CAS lands on this
 * row and the assertions below observe a genuine transition rather than a mock.
 */
function stageSession(status = "RUNNING", currentStep = 3) {
  const row: Record<string, unknown> = {
    id: SESSION_ID,
    orgId: ORG_ID,
    userId: USER_ID,
    status,
    currentStep,
    finalResponse: null,
    errorMessage: null,
    terminalReason: null,
    promptVersion: "v6",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };

  store.sessions.push(row);

  return row;
}

function stageRunningExecution(id = "exec_three_loop", overrides = {}) {
  const row: Record<string, unknown> = {
    id,
    sessionId: SESSION_ID,
    toolCallId: TOOL_CALL_ID,
    toolName: "generateWorkflow",
    status: "RUNNING",
    input: {},
    result: null,
    error: null,
    proposalState: null,
    proposalFingerprint: null,
    proposalRevision: null,
    criticalityDecisions: null,
    clarificationAnswer: null,
    expiresAt: null,
    expiredAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };

  store.executions.push(row);

  return row;
}

function sessionStatus(): string | undefined {
  return store.sessions.find((row) => row.id === SESSION_ID)?.status as
    | string
    | undefined;
}

beforeEach(() => {
  jest.clearAllMocks();
  restorePrismaDouble();
  resetStore();

  createMessageMock.mockResolvedValue({} as never);
  getMessagesMock.mockResolvedValue([] as never);
  recordAgentEventMock.mockResolvedValue({ id: "o1", deduped: false });
  getToolExecutionForWorkerMock.mockResolvedValue({
    id: "exec_three_loop",
    sessionId: SESSION_ID,
    toolName: "generateWorkflow",
    toolCallId: TOOL_CALL_ID,
    input: {},
    session: {
      orgId: ORG_ID,
      userId: USER_ID,
      status: "RUNNING",
      currentStep: 3,
    },
  } as never);
  markToolExecutionRunningMock.mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// Case A — model self-correction (never a human wait)
// ---------------------------------------------------------------------------

describe("Case A — self-correction: a structured failure corrects through the model", () => {
  it("records exactly one continuation intent and does NOT park the session", async () => {
    stageSession("RUNNING", 3);
    stageRunningExecution();

    getToolExecutorMock.mockReturnValue(async () => ({
      type: "json",
      value: {
        ok: false,
        code: "INVALID_INPUT",
        error: "The proposal has a cycle.",
        issues: [
          { path: "steps.follow.dependsOn", code: "CYCLE", message: "cycle" },
        ],
      },
    }));

    await handleToolExecution({
      event: {
        data: {
          orgId: ORG_ID,
          sessionId: SESSION_ID,
          executionId: "exec_three_loop",
          expectedStep: 3,
        },
      },
    });

    // The correction re-enters through the EXISTING outbox path, exactly once.
    expect(recordAgentEventMock).toHaveBeenCalledTimes(1);
    const event = recordAgentEventMock.mock.calls[0][0] as {
      eventType: string;
    };
    expect(event.eventType).toBe("AGENT_LOOP_REQUESTED");

    // A correctable validation failure is a CONTINUATION, not a human wait.
    expect(sessionStatus()).toBe("RUNNING");
    expect(sessionStatus()).not.toBe("WAITING_CONFIRMATION");

    // The result is durable and terminal on the execution.
    const execution = store.executions.find(
      (row) => row.id === "exec_three_loop",
    );
    expect(execution?.status).toBe("COMPLETED");
  });

  it("does not invoke any workflow-step retry/rollback machinery", async () => {
    stageSession("RUNNING", 3);
    stageRunningExecution();

    getToolExecutorMock.mockReturnValue(async () => ({
      type: "json",
      value: { ok: false, code: "INVALID_INPUT", issues: [] },
    }));

    await handleToolExecution({
      event: {
        data: {
          orgId: ORG_ID,
          sessionId: SESSION_ID,
          executionId: "exec_three_loop",
          expectedStep: 3,
        },
      },
    });

    // No workflow was started and no materialization ran: the correction path is
    // the agent loop, never the workflow executor.
    expect(store.workflows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Case B — human clarification (parks, then resumes on an answer)
// ---------------------------------------------------------------------------

describe("Case B — clarification: parks on a human, resumes through the loop", () => {
  function stageClarificationResult() {
    getToolExecutorMock.mockReturnValue(async () => ({
      type: "json",
      value: {
        ok: false,
        status: "NEEDS_USER_INPUT",
        code: "NEEDS_USER_INPUT",
        error: "Clarification required.",
        correlationId: CORRELATION_ID,
        fields: [
          {
            field: "projectId",
            reason: "missing",
            question: "Which project?",
          },
        ],
      },
    }));
  }

  it("parks the session WAITING_CONFIRMATION and records NO loop event", async () => {
    stageSession("RUNNING", 3);
    stageRunningExecution();

    stageClarificationResult();

    await handleToolExecution({
      event: {
        data: {
          orgId: ORG_ID,
          sessionId: SESSION_ID,
          executionId: "exec_three_loop",
          expectedStep: 3,
        },
      },
    });

    // The session is durably parked on a human.
    expect(sessionStatus()).toBe("WAITING_CONFIRMATION");

    // The halt must NOT re-drive the model: doing so spins on the same input.
    expect(recordAgentEventMock).not.toHaveBeenCalled();

    // The clarification remains distinguishable from approval: the durable
    // result carries NEEDS_USER_INPUT, not a PENDING_CONFIRMATION execution.
    const execution = store.executions.find(
      (row) => row.id === "exec_three_loop",
    );
    expect(execution?.status).toBe("COMPLETED");
    expect(execution?.proposalState).toBe(
      AgentProposalState.NEEDS_CLARIFICATION,
    );
  });

  it("an accepted answer clears the wait and records exactly one continuation", async () => {
    stageSession("WAITING_CONFIRMATION", 3);
    stageRunningExecution("exec_three_loop", {
      status: "COMPLETED",
      proposalState: AgentProposalState.NEEDS_CLARIFICATION,
      proposalFingerprint: CORRELATION_ID,
    });

    const transcript: {
      step: number;
      toolCallId: string | null;
      message: unknown;
      createdAt: Date;
    }[] = [
      {
        step: 3,
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
                  code: "NEEDS_USER_INPUT",
                  interactionId: "exec_three_loop",
                  correlationId: CORRELATION_ID,
                  fields: [
                    {
                      field: "projectId",
                      reason: "missing",
                      question: "Which project?",
                    },
                  ],
                },
              },
            },
          ],
        },
      },
    ];

    getMessagesMock.mockImplementation(async () => transcript as never);
    createMessageMock.mockImplementation(async (args: { message: unknown; toolCallId?: string; step: number }) => {
      transcript.push({
        step: args.step,
        toolCallId: args.toolCallId ?? null,
        message: args.message,
        createdAt: new Date(transcript.length),
      });
      return {} as never;
    });
    getAgentSessionForUserMock.mockResolvedValue({
      id: SESSION_ID,
      orgId: ORG_ID,
      userId: USER_ID,
      status: "WAITING_CONFIRMATION",
      currentStep: 3,
    } as never);

    const result = await submitClarificationAnswer({
      sessionId: SESSION_ID,
      userId: USER_ID,
      interactionId: "exec_three_loop",
      correlationId: CORRELATION_ID,
      answers: { projectId: PROJECT_ID },
    });

    expect(result.ok).toBe(true);

    // The wait is released and the loop resumes.
    expect(sessionStatus()).toBe("RUNNING");
    expect(recordAgentEventMock).toHaveBeenCalledTimes(1);
    expect(recordAgentEventMock.mock.calls[0][0]).toMatchObject({
      eventType: "AGENT_LOOP_REQUESTED",
    });

    // A duplicate answer is idempotent: no second continuation.
    const repeat = await submitClarificationAnswer({
      sessionId: SESSION_ID,
      userId: USER_ID,
      interactionId: "exec_three_loop",
      correlationId: CORRELATION_ID,
      answers: { projectId: PROJECT_ID },
    });

    expect(repeat.ok).toBe(true);
    if (repeat.ok) {
      expect(repeat.idempotent).toBe(true);
    }
    expect(recordAgentEventMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Case C — human approval (parks, decided, never re-enters the model)
// ---------------------------------------------------------------------------

describe("Case C — approval: parks on a human, decision never re-enters the loop", () => {
  it("parks the session WAITING_CONFIRMATION beside a PENDING decision, with NO loop event", async () => {
    stageSession("RUNNING", 3);
    stageRunningExecution();

    getToolExecutorMock.mockReturnValue(async () => ({
      type: "json",
      value: { ok: true, proposal: VALID_PROPOSAL },
    }));

    await handleToolExecution({
      event: {
        data: {
          orgId: ORG_ID,
          sessionId: SESSION_ID,
          executionId: "exec_three_loop",
          expectedStep: 3,
        },
      },
    });

    // The session is parked on a human.
    expect(sessionStatus()).toBe("WAITING_CONFIRMATION");

    // A parked proposal is a HALT: no continuation is recorded for the park.
    expect(recordAgentEventMock).not.toHaveBeenCalled();

    // The proposal remains distinguishable from clarification: it is parked at
    // AWAITING_CRITICALITY with a revision, not a NEEDS_USER_INPUT result.
    const execution = store.executions.find(
      (row) => row.id === "exec_three_loop",
    );
    expect(execution?.proposalState).toBe(
      AgentProposalState.AWAITING_CRITICALITY,
    );
    expect(execution?.proposalRevision).toBe(1);
  });

  it("an approved proposal clears the wait and records NO loop event", async () => {
    stageSession("WAITING_CONFIRMATION", 3);
    stageRunningExecution("exec_three_loop", {
      status: "COMPLETED",
      result: { ok: true, proposal: VALID_PROPOSAL },
      proposalState: AgentProposalState.AWAITING_APPROVAL,
      proposalFingerprint: computeProposalCorrelationId(VALID_PROPOSAL),
      proposalRevision: 1,
      criticalityDecisions: { kickoff: false, follow: false },
    });
    getAgentSessionForUserMock.mockResolvedValue({
      id: SESSION_ID,
      orgId: ORG_ID,
      userId: USER_ID,
      status: "WAITING_CONFIRMATION",
      currentStep: 3,
    } as never);

    const result = await submitProposalDecision({
      sessionId: SESSION_ID,
      userId: USER_ID,
      interactionId: "exec_three_loop",
      decision: AgentProposalState.APPROVED,
    });

    expect(result).toMatchObject({ ok: true, state: AgentProposalState.APPROVED });

    // A human decision is terminal for this loop: the wait is released but the
    // model is NEVER re-driven to act on the decision.
    expect(sessionStatus()).toBe("RUNNING");
    expect(recordAgentEventMock).not.toHaveBeenCalled();

    const execution = store.executions.find(
      (row) => row.id === "exec_three_loop",
    );
    expect(execution?.proposalState).toBe(AgentProposalState.APPROVED);

    // No workflow was started here: materialization is 37.11's concern.
    expect(store.workflows).toHaveLength(0);
  });
});
