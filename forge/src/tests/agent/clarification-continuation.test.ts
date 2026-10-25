// src/tests/agent/clarification-continuation.test.ts
//
// Assignment 37.6 — the CONNECTED same-session continuation path.
//
// This is the integration seam the local unit tests did not cover. It drives
// the real application boundary end to end:
//
//   worker produces NEEDS_USER_INPUT and pauses (no continuation)
//     -> GET-visible pending request is persisted with the execution id
//     -> POST answer accepts it and records the answer + AGENT_LOOP_REQUESTED
//     -> the REAL outbox dispatcher claims and publishes that intent
//     -> the REAL agent-loop handler claims the next step on the SAME session
//     -> the REAL loop runner asks the (mocked) model for a regenerated proposal
//     -> generateWorkflow runs again and the REAL compiler is invoked
//     -> the result is still a proposal: nothing is materialised or executed
//
// Mocked boundaries, and only these:
//   - prisma extended + db  -> in-memory double (database boundary)
//   - events/queue publishEvent (broker boundary)
//   - agent/status publishAgentStatus (Pusher boundary)
//   - auth/auth (identity boundary; returns a fixed signed-in user)
//   - agent/locks (Redis boundary; runs the callback inline)
//   - agent/model (the model/provider boundary): replaced with a real
//     `MockLanguageModelV3`, so the genuine `generateText` in the loop runner
//     still runs and only the provider transport is substituted
//   - workflow trigger startWorkflow (materialisation boundary)
//
// `claimNextAgentStep` and `compileWorkflowProposal` are wrapped rather than
// replaced: the real implementations still run, and the wrappers exist only so
// the test can observe that the production functions were actually called.

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

jest.mock("@/lib/auth/auth", () => ({ auth: jest.fn() }));

jest.mock("@/lib/security/vault/policy", () => ({
  resolveOrganizationAiPolicy: jest.fn().mockResolvedValue({
    orgId: "org_1",
    purpose: "GENERATION",
    allowPlatformFallback: true,
    requiresByok: false,
    tierResolved: true,
    tierIdentifier: "plan_test",
    reason: "Active subscription entitled to Forge platform AI fallback.",
  }),
}));

jest.mock("@/lib/ai/agent/model", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { MockLanguageModelV3 } = require("ai/test");
  return {
    agentModel: new MockLanguageModelV3({
      modelId: "test-model",
      provider: "test-provider",
    }),
  };
});

jest.mock("@/lib/ai/agent/locks", () => {
  const run = async <T>(_id: string, cb: () => Promise<T>): Promise<T> => cb();
  return {
    withAgentSessionLock: jest.fn(run),
    withToolExecutionLock: jest.fn(run),
  };
});

jest.mock("@/lib/workflow/execution/trigger", () => ({
  startWorkflow: jest.fn(),
}));

// Wrap, do not replace: the real CAS still runs; we only record the call.
jest.mock("@/lib/ai/agent/session-service", () => {
  const actual = jest.requireActual("@/lib/ai/agent/session-service");
  return {
    ...actual,
    claimNextAgentStep: jest.fn(actual.claimNextAgentStep),
  };
});

// Wrap, do not replace: the real compiler still runs; we record the arguments.
jest.mock("@/lib/workflow-types/workflow-proposal-compiler", () => {
  const actual = jest.requireActual(
    "@/lib/workflow-types/workflow-proposal-compiler",
  );
  return {
    ...actual,
    compileWorkflowProposal: jest.fn(actual.compileWorkflowProposal),
  };
});

import { auth } from "@/lib/auth/auth";
import { publishEvent } from "@/lib/events/queue";
import { agentModel } from "@/lib/ai/agent/model";
import { AGENT_PROMPT_VERSION } from "@/lib/ai/agent/prompts/system-prompt";
import { claimNextAgentStep } from "@/lib/ai/agent/session-service";
import { compileWorkflowProposal } from "@/lib/workflow-types/workflow-proposal-compiler";
import { startWorkflow } from "@/lib/workflow/execution/trigger";
import { dispatchOutboxBatch } from "@/lib/ai/agent/outbox";
import { handleAgentLoop } from "@/app/api/worker/agent-loop/al";
import { handleToolExecution } from "@/lib/ai/agent/tool-worker";
import { POST as clarificationPost } from "@/app/api/agent/session/[sessionId]/clarification/route";
import { createTaskAction } from "@/lib/workflow/actions/core/create-task";
import { resetStore, restorePrismaDouble, store } from "./helpers/prisma-double";

const authMock = auth as jest.MockedFunction<typeof auth>;
const publishEventMock = publishEvent as jest.MockedFunction<
  typeof publishEvent
>;
const claimStepMock = claimNextAgentStep as jest.MockedFunction<
  typeof claimNextAgentStep
>;
const compileMock = compileWorkflowProposal as jest.MockedFunction<
  typeof compileWorkflowProposal
>;
const startWorkflowMock = startWorkflow as jest.MockedFunction<
  typeof startWorkflow
>;
const modelMock = agentModel as unknown as {
  doGenerate: (options: unknown) => Promise<unknown>;
};

const SESSION_ID = "clxsessionaaaaaaaaaaaaaa";
const ORG_ID = "org_1";
const USER_ID = "user_1";
const EXECUTION_ID = "clxexecutedddddddddddddd";
const TOOL_CALL_ID = "call_clar_1";
const REGEN_TOOL_CALL_ID = "call_regen_1";
const MISSING_FIELD = "steps.step1.inputs.projectId";
const PROJECT_ID = "clxyz0000000000000000000a";

type Row = Record<string, unknown>;

const incompleteProposal = {
  name: "Onboard Acme",
  steps: {
    step1: {
      action: "task.create",
      inputs: { title: "Onboarding call" },
      dependsOn: [],
    },
  },
  clarifications: [
    {
      field: MISSING_FIELD,
      reason: "task.create requires a project",
      question: "Which project?",
    },
  ],
};

const regeneratedProposal = {
  name: "Onboard Acme",
  steps: {
    step1: {
      action: "task.create",
      inputs: { title: "Onboarding call", projectId: PROJECT_ID },
      dependsOn: [],
    },
  },
};

// A v3 LanguageModel doGenerate result that emits the single, regenerated
// generateWorkflow tool call. The real `generateText` turns this into the
// finishReason/toolCalls/response.messages the loop runner consumes, so the
// loop code under test is never mocked.
const regeneratedModelResult = {
  content: [
    {
      type: "tool-call",
      toolCallId: REGEN_TOOL_CALL_ID,
      toolName: "generateWorkflow",
      input: JSON.stringify(regeneratedProposal),
    },
  ],
  finishReason: { unified: "tool-calls", raw: "tool-calls" },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  warnings: [],
};

function seedSession(overrides: Row = {}): void {
  store.sessions = [
    {
      id: SESSION_ID,
      orgId: ORG_ID,
      userId: USER_ID,
      status: "RUNNING",
      currentStep: 2,
      finalResponse: null,
      errorMessage: null,
      terminalReason: null,
      promptVersion: AGENT_PROMPT_VERSION,
      createdAt: new Date(),
      updatedAt: new Date(),
      organization: { id: ORG_ID, name: "Acme" },
      user: { id: USER_ID, name: "User", email: "user@example.com" },
      ...overrides,
    },
  ];
}

function seedClarificationExecution(): void {
  store.executions = [
    {
      id: EXECUTION_ID,
      sessionId: SESSION_ID,
      toolCallId: TOOL_CALL_ID,
      toolName: "generateWorkflow",
      input: incompleteProposal,
      status: "PENDING",
      error: null,
      confirmedAt: null,
      cancelledAt: null,
      expiresAt: null,
      expiredAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];
}

function toolResultValue(row: Row | undefined): Row | undefined {
  if (!row) return undefined;

  const message = row.message as { content?: unknown } | undefined;

  if (!message || !Array.isArray(message.content)) return undefined;

  for (const part of message.content as Row[]) {
    if (part.type === "tool-result") {
      const output = part.output as { value?: Row } | undefined;
      if (output?.value) return output.value;
    }
  }

  return undefined;
}

function answerRequest(body: Row) {
  return clarificationPost(
    new Request(
      `http://localhost/api/agent/session/${SESSION_ID}/clarification`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ sessionId: SESSION_ID }) },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  restorePrismaDouble();
  resetStore();
  seedSession();
  seedClarificationExecution();
  // The transcript the loop resumes from: the assistant turn that requested
  // the generateWorkflow call, followed (by the worker) by its tool result.
  store.messages = [
    {
      sessionId: SESSION_ID,
      step: 2,
      createdAt: new Date(0),
      message: {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: TOOL_CALL_ID,
            toolName: "generateWorkflow",
            input: incompleteProposal,
          },
        ],
      },
    },
  ];
  store.outbox = [];
  authMock.mockResolvedValue({ user: { id: USER_ID } } as never);
});

describe("connected answer -> outbox -> same-session continuation", () => {
  it("resumes the same session through the existing dispatch and loop code", async () => {
    const executeSpy = jest.spyOn(createTaskAction, "execute");

    // 1. Worker boundary produces and persists NEEDS_USER_INPUT.
    await handleToolExecution({
      event: {
        data: {
          orgId: ORG_ID,
          sessionId: SESSION_ID,
          executionId: EXECUTION_ID,
          expectedStep: 2,
        },
      },
    });

    const clarificationRow = store.messages.find(
      (row) => toolResultValue(row)?.code === "NEEDS_USER_INPUT",
    );
    const clarificationValue = toolResultValue(clarificationRow);

    // 2/3. The ask is persisted with the actual AgentToolExecution id.
    expect(clarificationValue?.interactionId).toBe(EXECUTION_ID);
    expect(typeof clarificationValue?.correlationId).toBe("string");
    expect(store.executions[0].status).toBe("COMPLETED");

    // 4. The pause records NO continuation before a human answers.
    expect(store.outbox).toHaveLength(0);

    const correlationId = clarificationValue?.correlationId as string;

    // 5/6. Accept the answer through the real application route.
    const res = await answerRequest({
      interactionId: EXECUTION_ID,
      correlationId,
      answers: { [MISSING_FIELD]: PROJECT_ID },
    });
    const body = (await res.json()) as Row;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      sessionId: SESSION_ID,
      step: 2,
      status: "ACCEPTED",
    });

    const loopRow = store.outbox.find(
      (row) => row.eventType === "AGENT_LOOP_REQUESTED",
    );
    expect(loopRow).toBeDefined();
    expect(loopRow?.idempotencyKey).toBe(
      `AGENT_LOOP_REQUESTED:${SESSION_ID}:2:clarification:${EXECUTION_ID}`,
    );
    expect(loopRow?.payload).toMatchObject({
      orgId: ORG_ID,
      sessionId: SESSION_ID,
      expectedStep: 2,
    });
    expect(
      store.messages.some(
        (row) =>
          row.toolCallId === EXECUTION_ID &&
          (row.message as { role?: string }).role === "user",
      ),
    ).toBe(true);

    // 7. The real outbox dispatcher publishes the intent.
    publishEventMock.mockClear();
    await dispatchOutboxBatch(10);

    const loopPublish = publishEventMock.mock.calls.find(
      ([eventType]) => eventType === "AGENT_LOOP_REQUESTED",
    );
    expect(loopPublish).toBeDefined();
    expect(loopRow?.status).toBe("PUBLISHED");

    const loopPayload = loopPublish?.[1] as Row;

    // The model boundary returns a regenerated, now-complete proposal.
    modelMock.doGenerate = async () => regeneratedModelResult;

    // 8/9. The real agent-loop handler claims the next step on THIS session.
    await handleAgentLoop({ event: { data: loopPayload as never } });

    expect(claimStepMock).toHaveBeenCalledWith(SESSION_ID, 2);
    expect(store.sessions[0].currentStep).toBe(3);
    expect(store.sessions[0].status).toBe("RUNNING");

    const regeneratedExecution = store.executions.find(
      (execution) => execution.toolCallId === REGEN_TOOL_CALL_ID,
    );
    expect(regeneratedExecution).toBeDefined();
    expect(regeneratedExecution?.toolName).toBe("generateWorkflow");

    // 10. Dispatch the regenerate-workflow tool execution through the outbox.
    publishEventMock.mockClear();
    await dispatchOutboxBatch(10);

    const toolPublish = publishEventMock.mock.calls.find(
      ([eventType]) => eventType === "AGENT_TOOL_EXECUTION_REQUESTED",
    );
    expect(toolPublish).toBeDefined();

    // 11. The REAL compiler runs again against the regenerated proposal.
    compileMock.mockClear();
    await handleToolExecution({
      event: { data: toolPublish?.[1] as never },
    });

    expect(compileMock).toHaveBeenCalledWith(regeneratedProposal);

    const regeneratedResult = store.messages
      .map((row) => ({ row, value: toolResultValue(row) }))
      .find(
        ({ row, value }) =>
          row.toolCallId === REGEN_TOOL_CALL_ID && value !== undefined,
      );

    expect(regeneratedResult?.value?.ok).toBe(true);
    expect(
      (regeneratedResult?.value?.proposal as { name?: string } | undefined)
        ?.name,
    ).toBe("Onboard Acme");

    // 12. Still a proposal: nothing materialised, nothing executed.
    expect(startWorkflowMock).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();

    executeSpy.mockRestore();
  });

  it("does not advance the session when the answer is stale", async () => {
    await handleToolExecution({
      event: {
        data: {
          orgId: ORG_ID,
          sessionId: SESSION_ID,
          executionId: EXECUTION_ID,
          expectedStep: 2,
        },
      },
    });

    const res = await answerRequest({
      interactionId: "exec_somewhere_else",
      correlationId: "prop_corr_deadbeefdeadbeef",
      answers: { [MISSING_FIELD]: PROJECT_ID },
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as Row;
    expect(body.code).toBe("STALE_CLARIFICATION");

    // No continuation intent, and the step is untouched.
    expect(
      store.outbox.some((row) => row.eventType === "AGENT_LOOP_REQUESTED"),
    ).toBe(false);
    expect(store.sessions[0].currentStep).toBe(2);
  });
});
