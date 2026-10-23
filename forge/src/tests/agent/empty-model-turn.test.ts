// src/tests/agent/empty-model-turn.test.ts
//
// Assignment 37.16 (live defect, found by the capstone) — a model turn that
// produced NEITHER a tool call NOR any text must not be reported as a
// successful completion.
//
// THE LIVE DEFECT
// ---------------
// The first capstone run reached Gemini and came back with a response that
// carried no content: no text, no tool call, and no error. The AI SDK reports
// that faithfully - `text` is "" and `response.messages` is empty - and it is
// not an exception, so nothing threw.
//
// The agent loop treated it as a COMPLETE turn. The session was marked
// COMPLETED with `finalResponse = ""`: no proposal, no tool execution, no
// clarification, no error, and a single transcript message (the user's own).
// A human looking at that session sees "completed" and nothing else.
//
// The session state that proves it (forge-hq, live database):
//
//   status=COMPLETED  currentStep=1  terminalReason=null  finalResponse=""
//   messages: 1 (the user message)   tool executions: 0
//
// WHAT THIS SUITE ASSERTS
// -----------------------
//   1. The pure policy: a turn with a tool call, or with text, has content. A
//      turn with neither is EMPTY and carries the provider's stop reason.
//   2. The loop runner: an empty turn returns FAILED / EMPTY_MODEL_RESPONSE,
//      never COMPLETE.
//   3. A turn with a tool call is NOT an empty turn, even though its text is
//      empty - the call is the whole message.
//   4. A turn with text still completes normally.
//
// The live reproduction of the underlying provider behaviour is not
// reproducible on demand (it is rare and provider-side), so the provider is
// mocked here and the ASSERTION is about the agent's handling of it, which is
// the part the application owns.

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

// Only the model call is replaced. The rest of `ai` is real, because the tool
// registry builds its tools with the real `tool()` helper.
jest.mock("ai", () => {
  const actual = jest.requireActual("ai");
  return { ...actual, generateText: jest.fn() };
});

jest.mock("@/lib/ai/agent/session-service", () => {
  const actual = jest.requireActual("@/lib/ai/agent/session-service");
  return { ...actual, getAgentSessionForWorker: jest.fn() };
});

jest.mock("@/lib/ai/agent/services/message-service", () => {
  const actual = jest.requireActual("@/lib/ai/agent/services/message-service");
  return {
    ...actual,
    getMessages: jest.fn(async () => []),
    createMessage: jest.fn(),
  };
});

import { generateText } from "ai";

import { runAgentLoop } from "@/lib/ai/agent/loop-runner";
import { decideEmptyTurn } from "@/lib/ai/agent/loop-policy";
import { getAgentSessionForWorker } from "@/lib/ai/agent/session-service";

const SESSION_ID = "sess_empty_turn";

const generateTextMock = generateText as jest.MockedFunction<
  typeof generateText
>;
const getSessionMock =
  getAgentSessionForWorker as jest.MockedFunction<
    typeof getAgentSessionForWorker
  >;

function stageSession() {
  getSessionMock.mockResolvedValue({
    id: SESSION_ID,
    orgId: "org_1",
    userId: "user_1",
    status: "RUNNING",
    currentStep: 1,
    promptVersion: "v6",
    finalResponse: null,
    errorMessage: null,
    terminalReason: null,
    organization: { id: "org_1", name: "Forge HQ" },
    user: { id: "user_1", name: "Admin", email: "admin@forge.com" },
  } as unknown as Awaited<ReturnType<typeof getAgentSessionForWorker>>);
}

/** A provider turn that said nothing at all. */
function emptyTurn(finishReason = "stop") {
  return {
    finishReason,
    text: "",
    reasoning: [],
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
    response: { messages: [], body: {} },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  stageSession();
});

// ---------------------------------------------------------------------------
// The pure policy
// ---------------------------------------------------------------------------

describe("decideEmptyTurn", () => {
  it("treats a turn with a tool call as content, even with no prose", () => {
    expect(
      decideEmptyTurn({ text: "", toolCallCount: 1, finishReason: "tool-calls" }),
    ).toEqual({ kind: "HAS_CONTENT" });
  });

  it("treats a turn with text as content", () => {
    expect(
      decideEmptyTurn({ text: "Here is the plan.", toolCallCount: 0, finishReason: "stop" }),
    ).toEqual({ kind: "HAS_CONTENT" });
  });

  it("treats whitespace-only text as no content", () => {
    expect(
      decideEmptyTurn({ text: "   \n ", toolCallCount: 0, finishReason: "stop" }),
    ).toEqual({
      kind: "EMPTY",
      stopReason: "stop",
      message: expect.stringContaining("no content"),
    });
  });

  it("carries the provider's stop reason into the diagnosis", () => {
    const decision = decideEmptyTurn({
      text: "",
      toolCallCount: 0,
      finishReason: "length",
    });

    expect(decision.kind).toBe("EMPTY");
    if (decision.kind !== "EMPTY") return;
    expect(decision.stopReason).toBe("length");
    expect(decision.message).toContain("length");
  });
});

// ---------------------------------------------------------------------------
// The loop runner
// ---------------------------------------------------------------------------

describe("runAgentLoop with a content-free model turn", () => {
  it("fails the turn instead of completing it with an empty answer", async () => {
    generateTextMock.mockResolvedValue(emptyTurn() as never);

    const result = await runAgentLoop(SESSION_ID);

    expect(result.kind).toBe("FAILED");
    if (result.kind !== "FAILED") return;
    expect(result.reason).toBe("EMPTY_MODEL_RESPONSE");
    expect(result.message).toContain("no content");
  });

  it("never reports an empty answer as a completion", async () => {
    generateTextMock.mockResolvedValue(emptyTurn() as never);

    const result = await runAgentLoop(SESSION_ID);

    expect(result.kind).not.toBe("COMPLETE");
    if (result.kind === "COMPLETE") {
      expect(result.response).not.toBe("");
    }
  });

  it("still completes a turn that produced text", async () => {
    generateTextMock.mockResolvedValue({
      ...emptyTurn(),
      text: "The workflow has been proposed.",
    } as never);

    const result = await runAgentLoop(SESSION_ID);

    expect(result).toEqual({
      kind: "COMPLETE",
      response: "The workflow has been proposed.",
    });
  });

  it("still dispatches a tool call, even though such a turn has no prose", async () => {
    generateTextMock.mockResolvedValue({
      ...emptyTurn("tool-calls"),
      toolCalls: [
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "generateWorkflow",
          input: { name: "Onboard Acme Enterprise", steps: {} },
        },
      ],
      response: {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call_1",
                toolName: "generateWorkflow",
                input: { name: "Onboard Acme Enterprise", steps: {} },
              },
            ],
          },
        ],
        body: {},
      },
    } as never);

    const result = await runAgentLoop(SESSION_ID);

    expect(result.kind).toBe("TOOL_CALL");
    if (result.kind !== "TOOL_CALL") return;
    expect(result.toolName).toBe("generateWorkflow");
  });
});
