// src/tests/agent/session-clarification-read.test.ts
//
// GET /api/agent/session/[sessionId] must expose the EXACT pending clarification
// derived from the persisted transcript, with the interactionId the worker
// stamped onto the request. This exercises the real handler and the real
// `findPendingClarification` helper against the in-memory prisma double, so the
// transcript scan and the response projection are both genuinely under test.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/auth/auth", () => ({ auth: jest.fn() }));

jest.mock("@/lib/events/queue", () => ({ publishEvent: jest.fn() }));

jest.mock("@/lib/ai/agent/locks", () => {
  const run = async <T>(_id: string, cb: () => Promise<T>): Promise<T> => cb();
  return {
    withAgentSessionLock: jest.fn(run),
    withToolExecutionLock: jest.fn(run),
  };
});

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

import { auth } from "@/lib/auth/auth";
import { AGENT_PROMPT_VERSION } from "@/lib/ai/agent/prompts/system-prompt";
import { GET } from "@/app/api/agent/session/[sessionId]/route";
import { resetStore, restorePrismaDouble, store } from "./helpers/prisma-double";

const authMock = auth as jest.MockedFunction<typeof auth>;

const SESSION_ID = "clxsessionaaaaaaaaaaaaaa";
const OTHER_SESSION_ID = "clxotherbbbbbbbbbbbbbbbb";
const INTERACTION_ID = "clxexecputedccccccccccc";
const TOOL_CALL_ID = "call_clar_1";
const CORRELATION_ID = "prop_corr_1234567890abcdef";
const MISSING_FIELD = "steps.step1.inputs.projectId";

type Row = Record<string, unknown>;

function session(overrides: Row = {}): Row {
  return {
    id: SESSION_ID,
    orgId: "org_1",
    userId: "user_a",
    status: "RUNNING",
    currentStep: 2,
    finalResponse: null,
    errorMessage: null,
    terminalReason: null,
    promptVersion: AGENT_PROMPT_VERSION,
    createdAt: new Date("2026-09-29T00:00:00.000Z"),
    updatedAt: new Date("2026-09-29T00:01:00.000Z"),
    ...overrides,
  };
}

function clarificationMessage({
  sessionId = SESSION_ID,
  interactionId = INTERACTION_ID,
  toolCallId = TOOL_CALL_ID,
  createdAt = new Date(0),
}: {
  sessionId?: string;
  interactionId?: string;
  toolCallId?: string;
  createdAt?: Date;
} = {}): Row {
  return {
    sessionId,
    step: 2,
    toolCallId,
    createdAt,
    message: {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: "generateWorkflow",
          output: {
            type: "json",
            value: {
              ok: false,
              status: "NEEDS_USER_INPUT",
              code: "NEEDS_USER_INPUT",
              error: "Clarification required.",
              interactionId,
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

function answerMessage({
  interactionId = INTERACTION_ID,
  createdAt = new Date(1),
}: {
  interactionId?: string;
  createdAt?: Date;
} = {}): Row {
  return {
    sessionId: SESSION_ID,
    step: 2,
    toolCallId: interactionId,
    createdAt,
    message: { role: "user", content: "Clarification response for ..." },
  };
}

function makeExecution(overrides: Row = {}): Row {
  return {
    id: INTERACTION_ID,
    sessionId: SESSION_ID,
    toolCallId: TOOL_CALL_ID,
    toolName: "generateWorkflow",
    input: { name: "Onboard", steps: {} },
    status: "PENDING",
    error: null,
    confirmedAt: null,
    cancelledAt: null,
    createdAt: new Date("2026-09-29T00:00:30.000Z"),
    updatedAt: new Date("2026-09-29T00:00:30.000Z"),
    ...overrides,
  };
}

function callGet(sessionId: string = SESSION_ID) {
  return GET(new Request("http://localhost"), {
    params: Promise.resolve({ sessionId }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  restorePrismaDouble();
  resetStore();
  authMock.mockResolvedValue({ user: { id: "user_a" } } as never);
  store.sessions = [
    session(),
    session({ id: OTHER_SESSION_ID, userId: "user_b" }),
  ];
  store.executions = [makeExecution()];
  store.messages = [clarificationMessage()];
});

describe("pending clarification is exposed verbatim", () => {
  it("returns the exact pending clarification with the worker-stamped interactionId", async () => {
    const res = await callGet();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    // The interactionId must be the persisted AgentToolExecution id, not a
    // value re-invented from the proposal text.
    expect(store.executions[0].id).toBe(INTERACTION_ID);
    expect(body.clarification).toEqual({
      interactionId: INTERACTION_ID,
      correlationId: CORRELATION_ID,
      toolName: "generateWorkflow",
      step: 2,
      fields: [
        {
          field: MISSING_FIELD,
          reason: "task.create requires a project",
          question: "Which project?",
        },
      ],
    });
  });

  it("keeps the ordinary session fields and the transcript intact", async () => {
    const res = await callGet();
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      sessionId: SESSION_ID,
      orgId: "org_1",
      status: "RUNNING",
      currentStep: 2,
      finalResponse: null,
      error: null,
      terminalReason: null,
      promptVersion: AGENT_PROMPT_VERSION,
    });
    expect(body.messages).toHaveLength(1);
    expect(body.toolExecutions).toHaveLength(1);
  });

  it("does not leak a clarification belonging to another session", async () => {
    store.sessions = [
      session(),
      session({ id: OTHER_SESSION_ID, userId: "user_b" }),
    ];
    store.messages = [
      clarificationMessage(),
      clarificationMessage({
        sessionId: OTHER_SESSION_ID,
        interactionId: "exec_other_session",
        toolCallId: "call_other",
        createdAt: new Date(2),
      }),
    ];

    const res = await callGet();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(
      (body.clarification as { interactionId: string }).interactionId,
    ).toBe(INTERACTION_ID);
    expect(JSON.stringify(body)).not.toContain("exec_other_session");
    expect(body.messages).toHaveLength(1);
  });

  it("returns clarification: null once the request has been answered", async () => {
    store.messages = [clarificationMessage(), answerMessage()];

    const res = await callGet();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.clarification).toBeNull();
  });
});

describe("unchanged authentication and ownership behaviour", () => {
  it("rejects an unauthenticated request with 401", async () => {
    authMock.mockResolvedValue(null as never);

    const res = await callGet();

    expect(res.status).toBe(401);
  });

  it("returns 404 for another user's session without disclosing a clarification", async () => {
    authMock.mockResolvedValue({ user: { id: "user_a" } } as never);

    const res = await callGet(OTHER_SESSION_ID);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(404);
    expect(body.clarification).toBeUndefined();
  });
});
