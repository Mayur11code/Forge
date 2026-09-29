// src/tests/agent/tool-confirmation-flow.test.ts
//
// Worker-side coverage for the confirmation state machine:
//   * the agent loop creates a PROPOSAL for write tools and halts,
//   * read-only tools dispatch immediately,
//   * the tool worker refuses to execute anything that is not PENDING,
//   * an unregistered tool fails the session closed.

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

jest.mock("@/lib/events/queue", () => ({ publishEvent: jest.fn() }));

jest.mock("@/lib/ai/agent/status", () => ({
  publishAgentStatus: jest.fn(),
}));

jest.mock("@/lib/ai/agent/locks", () => ({
  withAgentSessionLock: jest.fn(
    async (_id: string, fn: () => Promise<void>) => fn(),
  ),
  withToolExecutionLock: jest.fn(
    async (_id: string, fn: () => Promise<void>) => fn(),
  ),
}));

jest.mock("@/lib/ai/agent/loop-runner", () => ({
  runAgentLoop: jest.fn(),
}));

jest.mock("@/lib/ai/agent/session-service", () => ({
  getAgentSessionForWorker: jest.fn(),
  claimNextAgentStep: jest.fn(),
  completeAgentSession: jest.fn(),
  failAgentSession: jest.fn(),
  terminateAgentSessionForMaxSteps: jest.fn(),
}));

jest.mock("@/lib/ai/agent/services/message-service", () => ({
  createMessage: jest.fn(),
}));

jest.mock("@/lib/ai/agent/services/tool-execution-service", () => ({
  createToolExecution: jest.fn(),
  confirmToolExecution: jest.fn(),
  cancelToolExecution: jest.fn(),
  abandonToolExecution: jest.fn(),
  completeToolExecution: jest.fn(),
  failToolExecution: jest.fn(),
  markToolExecutionRunning: jest.fn(),
  heartbeatToolExecution: jest.fn(async () => true),
  getToolExecutionForWorker: jest.fn(),
}));

import { publishEvent } from "@/lib/events/queue";
import { publishAgentStatus } from "@/lib/ai/agent/status";
import { runAgentLoop } from "@/lib/ai/agent/loop-runner";
import {
  claimNextAgentStep,
  failAgentSession,
  getAgentSessionForWorker,
} from "@/lib/ai/agent/session-service";
import { createMessage } from "@/lib/ai/agent/services/message-service";
import {
  abandonToolExecution,
  completeToolExecution,
  createToolExecution,
  getToolExecutionForWorker,
  markToolExecutionRunning,
} from "@/lib/ai/agent/services/tool-execution-service";
import { handleAgentLoop } from "@/app/api/worker/agent-loop/al";
import { handleToolExecution } from "@/lib/ai/agent/tool-worker";

const publishEventMock = publishEvent as jest.MockedFunction<
  typeof publishEvent
>;
const publishStatusMock =
  publishAgentStatus as jest.MockedFunction<typeof publishAgentStatus>;
const runLoopMock = runAgentLoop as jest.MockedFunction<
  typeof runAgentLoop
>;
const getSessionMock =
  getAgentSessionForWorker as jest.MockedFunction<
    typeof getAgentSessionForWorker
  >;
const claimMock = claimNextAgentStep as jest.MockedFunction<
  typeof claimNextAgentStep
>;
const failSessionMock = failAgentSession as jest.MockedFunction<
  typeof failAgentSession
>;
const createExecutionMock =
  createToolExecution as jest.MockedFunction<typeof createToolExecution>;
const markRunningMock = markToolExecutionRunning as jest.MockedFunction<
  typeof markToolExecutionRunning
>;
const abandonMock = abandonToolExecution as jest.MockedFunction<
  typeof abandonToolExecution
>;
const completeMock = completeToolExecution as jest.MockedFunction<
  typeof completeToolExecution
>;
const getExecutionMock =
  getToolExecutionForWorker as jest.MockedFunction<
    typeof getToolExecutionForWorker
  >;
const createMessageMock = createMessage as jest.MockedFunction<
  typeof createMessage
>;

const SESSION_ID = "clxsessionaaaaaaaaaaaaaa";
const EXECUTION_ID = "clxexecccccccccccccccc";

function workerSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    orgId: "org_1",
    userId: "user_a",
    status: "RUNNING",
    currentStep: 1,
    organization: { id: "org_1", name: "Acme" },
    user: { id: "user_a", name: "A", email: "a@x.com" },
    ...overrides,
  } as never;
}

function toolCallResult(toolName = "createTask") {
  return {
    kind: "TOOL_CALL" as const,
    toolCallId: "call_1",
    toolName,
    input: { title: "Fix login", projectName: "Web" },
  };
}

function driveLoop(result: ReturnType<typeof toolCallResult>) {
  return handleAgentLoop({
    event: { data: { sessionId: SESSION_ID, expectedStep: 1 } },
  } as never).then(async () => {
    void result;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  getSessionMock.mockResolvedValue(workerSession());
  claimMock.mockResolvedValue(true);
  failSessionMock.mockResolvedValue({ count: 1 } as never);
  runLoopMock.mockResolvedValue(toolCallResult());
  createExecutionMock.mockResolvedValue({
    id: EXECUTION_ID,
    toolName: "createTask",
    input: { title: "Fix login", projectName: "Web" },
    status: "PENDING_CONFIRMATION",
  } as never);
});

describe("agent loop: write tool proposal", () => {
  it("persists the proposal instead of dispatching it", async () => {
    await driveLoop(toolCallResult());

    expect(createExecutionMock).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      toolCallId: "call_1",
      toolName: "createTask",
      input: { title: "Fix login", projectName: "Web" },
      requiresConfirmation: true,
    });

    // The proposal is the ONLY copy of these arguments. Nothing is executed
    // until the user confirms, and nothing is regenerated.
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it("publishes a displayable proposal built from the persisted input", async () => {
    await driveLoop(toolCallResult());

    expect(publishStatusMock).toHaveBeenCalledWith(SESSION_ID, {
      type: "TOOL_PROPOSED",
      executionId: EXECUTION_ID,
      toolName: "createTask",
      summary: expect.stringContaining("Fix login"),
      fields: expect.arrayContaining([
        { label: "Title", value: "Fix login" },
        { label: "Project", value: "Web" },
      ]),
    });
  });
});

describe("agent loop: unregistered tool", () => {
  it("fails the session closed rather than dispatching", async () => {
    runLoopMock.mockResolvedValue(
      toolCallResult("deleteEverything") as never,
    );

    await driveLoop(toolCallResult());

    expect(createExecutionMock).not.toHaveBeenCalled();
    expect(publishEventMock).not.toHaveBeenCalled();
    expect(failSessionMock).toHaveBeenCalledWith(
      SESSION_ID,
      expect.stringContaining("deleteEverything"),
      "TOOL_NOT_AVAILABLE",
    );
  });
});

describe("tool worker: execution gating", () => {
  function toolExecutionEvent(executionId = EXECUTION_ID) {
    return {
      event: {
        data: {
          sessionId: SESSION_ID,
          executionId,
          expectedStep: 2,
        },
      },
    } as never;
  }

  it("refuses to claim a cancelled execution", async () => {
    getExecutionMock.mockResolvedValue({
      id: EXECUTION_ID,
      sessionId: SESSION_ID,
      toolName: "createTask",
      status: "CANCELLED",
      session: {
        orgId: "org_1",
        userId: "user_a",
        status: "RUNNING",
        currentStep: 1,
      },
    } as never);
    // The CAS from PENDING fails, which is the structural guarantee that a
    // cancelled proposal can never run.
    markRunningMock.mockResolvedValue(false);

    await handleToolExecution(toolExecutionEvent());

    expect(createMessageMock).not.toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it("refuses to claim an execution still awaiting confirmation", async () => {
    getExecutionMock.mockResolvedValue({
      id: EXECUTION_ID,
      sessionId: SESSION_ID,
      toolName: "createTask",
      status: "PENDING_CONFIRMATION",
      session: {
        orgId: "org_1",
        userId: "user_a",
        status: "RUNNING",
        currentStep: 1,
      },
    } as never);
    markRunningMock.mockResolvedValue(false);

    await handleToolExecution(toolExecutionEvent());

    expect(createMessageMock).not.toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("abandons an execution whose session is no longer running", async () => {
    getExecutionMock.mockResolvedValue({
      id: EXECUTION_ID,
      sessionId: SESSION_ID,
      toolCallId: "call_1",
      toolName: "createTask",
      input: { title: "Fix login", projectName: "Web" },
      status: "PENDING",
      session: {
        orgId: "org_1",
        userId: "user_a",
        status: "COMPLETED",
        currentStep: 1,
      },
    } as never);
    markRunningMock.mockResolvedValue(true);
    abandonMock.mockResolvedValue(true);

    await handleToolExecution(toolExecutionEvent());

    // The row is closed out instead of being left in flight, and the side
    // effect never happens.
    expect(abandonMock).toHaveBeenCalledWith(
      EXECUTION_ID,
      expect.stringContaining("COMPLETED"),
    );
    expect(createMessageMock).toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
  });
});