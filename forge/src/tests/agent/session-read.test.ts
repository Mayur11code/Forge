// src/tests/agent/session-read.test.ts
//
// Authorization and response contract for GET /api/agent/session/[sessionId].

jest.mock("server-only", () => ({}));

// Both prisma modules are mocked because `prisma/extended` imports
// `prisma/db` at module scope, so mocking only one still constructs a real
// PrismaClient - which next/jest points at the live DATABASE_URL from .env.
// jest.setup-db-guard.ts turns that mistake into an immediate failure instead
// of a connection timeout.
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

jest.mock("@/lib/auth/auth", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/ai/agent/session-service", () => ({
  getAgentSessionForUser: jest.fn(),
}));

jest.mock("@/lib/ai/agent/services/message-service", () => ({
  getMessages: jest.fn(),
}));

jest.mock("@/lib/ai/agent/services/tool-execution-service", () => ({
  getToolExecutionsForSession: jest.fn(),
}));

import { auth } from "@/lib/auth/auth";
import { getAgentSessionForUser } from "@/lib/ai/agent/session-service";
import { getMessages } from "@/lib/ai/agent/services/message-service";
import { getToolExecutionsForSession } from "@/lib/ai/agent/services/tool-execution-service";
import { GET } from "@/app/api/agent/session/[sessionId]/route";

const authMock = auth as jest.MockedFunction<typeof auth>;
const getSessionMock =
  getAgentSessionForUser as jest.MockedFunction<
    typeof getAgentSessionForUser
  >;
const getMessagesMock = getMessages as jest.MockedFunction<typeof getMessages>;
const getExecutionsMock =
  getToolExecutionsForSession as jest.MockedFunction<
    typeof getToolExecutionsForSession
  >;

const SESSION_ID = "clx1234567890abcdefghijkl";

function callGet(sessionId: string = SESSION_ID) {
  return GET(new Request("http://localhost"), {
    params: Promise.resolve({ sessionId }),
  });
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    orgId: "org_1",
    userId: "user_a",
    status: "RUNNING",
    currentStep: 2,
    finalResponse: null,
    errorMessage: null,
    terminalReason: null,
    createdAt: new Date("2026-09-29T00:00:00.000Z"),
    updatedAt: new Date("2026-09-29T00:01:00.000Z"),
    ...overrides,
  } as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  getMessagesMock.mockResolvedValue([]);
  getExecutionsMock.mockResolvedValue([]);
});

describe("unauthenticated", () => {
  it("rejects with 401 and does not touch the session", async () => {
    authMock.mockResolvedValue(null as never);

    const res = await callGet();

    expect(res.status).toBe(401);
    expect(getSessionMock).not.toHaveBeenCalled();
  });
});

describe("ownership", () => {
  it("returns 404 for another user's session and does not leak data", async () => {
    authMock.mockResolvedValue({ user: { id: "user_a" } } as never);
    // The owner-scoped lookup filters on userId, so a foreign session yields
    // null and is indistinguishable from a missing one.
    getSessionMock.mockResolvedValue(null);

    const res = await callGet("clxsomeoneelsessession");

    expect(res.status).toBe(404);
    expect(getSessionMock).toHaveBeenCalledWith({
      sessionId: "clxsomeoneelsessession",
      userId: "user_a",
    });
    expect(getMessagesMock).not.toHaveBeenCalled();
    expect(getExecutionsMock).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown session", async () => {
    authMock.mockResolvedValue({ user: { id: "user_a" } } as never);
    getSessionMock.mockResolvedValue(null);

    const res = await callGet("clxdoesnotexist");

    expect(res.status).toBe(404);
  });

  it("rejects an empty session id", async () => {
    authMock.mockResolvedValue({ user: { id: "user_a" } } as never);

    const res = await callGet("");

    expect(res.status).toBe(400);
    expect(getSessionMock).not.toHaveBeenCalled();
  });
});

describe("authorized response", () => {
  it("returns the session state for the owner", async () => {
    authMock.mockResolvedValue({ user: { id: "user_a" } } as never);
    getSessionMock.mockResolvedValue(session());
    getMessagesMock.mockResolvedValue([
      {
        id: "msg_1",
        step: 0,
        toolCallId: null,
        message: { role: "user", content: "hi" },
        createdAt: new Date("2026-09-29T00:00:00.000Z"),
      },
    ] as never);
    getExecutionsMock.mockResolvedValue([
      {
        id: "exec_1",
        toolCallId: "call_1",
        toolName: "createTask",
        input: { title: "t" },
        status: "PENDING",
        error: null,
        createdAt: new Date("2026-09-29T00:00:30.000Z"),
        updatedAt: new Date("2026-09-29T00:00:30.000Z"),
      },
    ] as never);

    const res = await callGet();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      sessionId: SESSION_ID,
      orgId: "org_1",
      status: "RUNNING",
      currentStep: 2,
      finalResponse: null,
      error: null,
      terminalReason: null,
    });
    expect(body.messages).toHaveLength(1);
    expect(body.toolExecutions).toHaveLength(1);
  });

  it("exposes the machine-readable terminal reason after max steps", async () => {
    authMock.mockResolvedValue({ user: { id: "user_a" } } as never);
    getSessionMock.mockResolvedValue(
      session({
        status: "FAILED",
        currentStep: 6,
        finalResponse: null,
        errorMessage: "Agent loop stopped: exceeded the maximum of 5 model turns.",
        terminalReason: "MAX_STEPS_EXCEEDED",
      }),
    );

    const res = await callGet();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.status).toBe("FAILED");
    expect(body.terminalReason).toBe("MAX_STEPS_EXCEEDED");
    expect(body.finalResponse).toBeNull();
  });
});
